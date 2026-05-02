"""AKShare-backed :class:`StockMetaSource`.

Fallback source per ``modules/01-stock-meta.md §3``. Like the Tushare
adapter, ``akshare`` is imported lazily so this file is harmless to
import even on machines without the SDK.

AKShare's `stock_info_a_code_name()` returns a DataFrame with two
columns (``code``, ``name``); board / industry / share counts are
filled from sibling endpoints in a future enrichment pass. For the
current sync the partial record is intentional — it is enough to seed
the universe and let the next full sync (with Tushare back online)
overwrite with richer data.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Final, Protocol, runtime_checkable

from quant_core.domain.types.stock import Board, Exchange, StockMeta, StockStatus
from quant_core.errors import QuantError

from quant_io.sources._common import (
    health_ok,
    health_unavailable,
    lazy_import,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from quant_core.domain.types.source import SourceHealth


_NAME: Final[str] = "akshare"
_DEFAULT_PRIORITY: Final[int] = 2
# Stand-in list_date for partial records; sync will overwrite later.
_PARTIAL_LIST_DATE: Final[date] = date(1990, 1, 1)


@runtime_checkable
class _AkshareGateway(Protocol):
    """Duck-typed view of the akshare module.

    The real ``akshare.stock_info_a_code_name()`` returns a ``pandas.DataFrame``
    whose columns are ``code`` and ``name``. We accept the loose ``object``
    return type and normalise via :func:`_iter_rows` so tests can pass either
    a DataFrame or a plain ``list[dict]`` without a pandas dependency.
    """

    def stock_info_a_code_name(self) -> object: ...


class AKShareStockMetaSource:
    """Best-effort fallback source for stock metadata."""

    __slots__ = ("_gateway", "_priority")

    def __init__(
        self,
        *,
        priority: int = _DEFAULT_PRIORITY,
        gateway: _AkshareGateway | None = None,
    ) -> None:
        self._priority = priority
        self._gateway = gateway

    @property
    def name(self) -> str:
        return _NAME

    @property
    def priority(self) -> int:
        return self._priority

    def healthcheck(self) -> SourceHealth:
        gw, reason = self._resolve_gateway()
        if gw is None:
            return health_unavailable(_NAME, reason or "unknown failure")
        return health_ok(_NAME)

    def fetch_all(self) -> Iterable[StockMeta]:
        gw, reason = self._resolve_gateway()
        if gw is None:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: {reason or 'unavailable'}",
                {"source": _NAME},
            )
        try:
            raw = gw.stock_info_a_code_name()
        except Exception as exc:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: stock_info_a_code_name failed: {exc}",
                {"source": _NAME, "exc_type": type(exc).__name__},
            ) from exc
        now = datetime.now(tz=UTC)
        for row in _iter_rows(raw):
            meta = _row_to_meta(row, now)
            if meta is not None:
                yield meta

    def fetch_one(self, code: str) -> StockMeta | None:
        for item in self.fetch_all():
            if item.code == code:
                return item
        return None

    # -- internals ------------------------------------------------------

    def _resolve_gateway(self) -> tuple[_AkshareGateway | None, str | None]:
        if self._gateway is not None:
            return self._gateway, None
        ak = lazy_import("akshare")
        if ak is None:
            return None, "akshare package not installed"
        if not isinstance(ak, _AkshareGateway):
            return None, "akshare module missing stock_info_a_code_name"
        self._gateway = ak
        return ak, None


def _iter_rows(raw: object) -> Iterable[Mapping[str, object]]:
    """Normalise the various row containers a gateway might return.

    AKShare hands back a ``pandas.DataFrame``; tests pass plain
    ``list[dict]``. We use ``to_dict("records")`` when available
    (DataFrames quack that way) and fall back to direct iteration for
    list-of-dict gateways. We **never** import pandas — keeping the
    adapter free of pandas types in its public surface keeps the type
    layer thin.
    """
    to_dict = getattr(raw, "to_dict", None)
    if callable(to_dict):
        records = to_dict("records")
        if isinstance(records, list):
            return records
    if isinstance(raw, list):
        return raw
    raise TypeError(f"akshare returned unsupported container: {type(raw).__name__}")


def _row_to_meta(row: Mapping[str, object], now: datetime) -> StockMeta | None:
    raw_code = _str(row.get("code"))
    name = _str(row.get("name"))
    if not raw_code or not name:
        return None
    code = _suffix_exchange(raw_code)
    if code is None:
        return None
    board: Board = "MAIN"
    status: StockStatus = "NORMAL"
    return StockMeta(
        code=code,
        name=name,
        name_pinyin="",
        exchange=_exchange_for(code),
        board=board,
        industry_sw_l1="",
        industry_sw_l2="",
        industry_sw_l3="",
        list_date=_PARTIAL_LIST_DATE,
        delist_date=None,
        total_share=Decimal(0),
        float_share=Decimal(0),
        status=status,
        updated_at=now,
    )


def _str(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _suffix_exchange(code: str) -> str | None:
    """AKShare returns bare 6-digit codes; tag with exchange suffix.

    Prefix → exchange map (current as of 2026):

    - SH main board: ``60`` (incl. ``600``/``601``/``603``/``605``)
    - SH STAR (科创板): ``688``, ``689``
    - SZ main: ``000``, ``001``, ``002``, ``003``
    - SZ ChiNext (创业板): ``300``, ``301``
    - BJ (北交所): ``43``, ``83``, ``87``, ``88``, ``920`` — note that
      ``920`` was added in 2024 and is what trips the naive "9 → SH" rule.
    - SH B-share: ``900`` (rare; we still tag as SH)
    """
    if not code.isdigit() or len(code) != 6:
        return None
    if code.startswith("920"):
        return f"{code}.BJ"
    if code.startswith(("60", "68", "900")):
        return f"{code}.SH"
    if code.startswith(("00", "30", "20")):
        return f"{code}.SZ"
    if code.startswith(("4", "8")):
        return f"{code}.BJ"
    return None


def _exchange_for(code: str) -> Exchange:
    suffix = code.split(".")[1] if "." in code else "SH"
    if suffix == "SH":
        return "SH"
    if suffix == "SZ":
        return "SZ"
    return "BJ"
