"""Tushare-backed :class:`StockMetaSource`.

The ``tushare`` SDK pulls in numpy/pandas — too heavy to require for
every install — so this adapter imports it lazily. When the package
or token is missing, ``healthcheck()`` reports ``available=False`` and
``fetch_all()`` raises ``QuantError(SOURCE_UNAVAILABLE)`` so the
:class:`SourceChain` falls back cleanly to the next source.

The `_TushareGateway` indirection lets tests swap a fake gateway in
without monkey-patching ``tushare`` itself.
"""

from __future__ import annotations

import os
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


_NAME: Final[str] = "tushare"
_DEFAULT_PRIORITY: Final[int] = 1


@runtime_checkable
class _TushareGateway(Protocol):
    """Minimal duck-typed view of ``tushare.pro_api()`` we depend on.

    Production: implemented by the real ``tushare`` package.
    Tests: a hand-rolled fake (see ``test_tushare_stock_meta.py``).
    """

    def stock_basic(self, **kwargs: object) -> Iterable[Mapping[str, object]]:
        """Return one mapping per listed stock with the documented columns."""
        ...


class TushareStockMetaSource:
    """Stock-meta adapter for Tushare Pro."""

    __slots__ = ("_gateway", "_priority", "_token")

    def __init__(
        self,
        *,
        token: str | None = None,
        priority: int = _DEFAULT_PRIORITY,
        gateway: _TushareGateway | None = None,
    ) -> None:
        self._token = token if token is not None else os.environ.get("TUSHARE_TOKEN")
        self._priority = priority
        self._gateway = gateway

    @property
    def name(self) -> str:
        return _NAME

    @property
    def priority(self) -> int:
        return self._priority

    # -- StockMetaSource ------------------------------------------------

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
            rows = gw.stock_basic(
                exchange="",
                list_status="L",
                fields="ts_code,name,exchange,industry,list_date,delist_date,total_share,float_share",
            )
        except Exception as exc:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: stock_basic failed: {exc}",
                {"source": _NAME, "exc_type": type(exc).__name__},
            ) from exc
        now = datetime.now(tz=UTC)
        for row in rows:
            meta = _row_to_meta(row, now)
            if meta is not None:
                yield meta

    def fetch_one(self, code: str) -> StockMeta | None:
        for item in self.fetch_all():
            if item.code == code:
                return item
        return None

    # -- internals ------------------------------------------------------

    def _resolve_gateway(self) -> tuple[_TushareGateway | None, str | None]:
        if self._gateway is not None:
            return self._gateway, None
        if self._token is None or not self._token:
            return None, "TUSHARE_TOKEN not set"
        ts = lazy_import("tushare")
        if ts is None:
            return None, "tushare package not installed"
        try:
            getattr(ts, "set_token")(self._token)  # noqa: B009
            pro = getattr(ts, "pro_api")()  # noqa: B009
        except Exception as exc:  # noqa: BLE001
            return None, f"pro_api init failed: {exc}"
        # `tushare.pro_api()` returns an object whose `.stock_basic` matches
        # our protocol structurally; trust it.
        gateway = pro
        if not isinstance(gateway, _TushareGateway):
            return None, "tushare gateway missing stock_basic"
        self._gateway = gateway
        return gateway, None


def _row_to_meta(row: Mapping[str, object], now: datetime) -> StockMeta | None:
    code = _str(row.get("ts_code"))
    name = _str(row.get("name"))
    exchange = _exchange(_str(row.get("exchange")))
    list_date = _yyyymmdd(_str(row.get("list_date")))
    if not code or not name or exchange is None or list_date is None:
        return None
    delist_date = _yyyymmdd(_str(row.get("delist_date")))
    status: StockStatus = "DELISTED" if delist_date is not None else "NORMAL"
    board: Board = "MAIN"
    return StockMeta(
        code=code,
        name=name,
        # Tushare doesn't expose pinyin; future enricher fills it in.
        name_pinyin="",
        exchange=exchange,
        board=board,
        industry_sw_l1="",
        industry_sw_l2=_str(row.get("industry")),
        industry_sw_l3="",
        list_date=list_date,
        delist_date=delist_date,
        total_share=_decimal(row.get("total_share")),
        float_share=_decimal(row.get("float_share")),
        status=status,
        updated_at=now,
    )


def _str(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _exchange(value: str) -> Exchange | None:
    upper = value.upper()
    if upper in ("SSE", "SH"):
        return "SH"
    if upper in ("SZSE", "SZ"):
        return "SZ"
    if upper in ("BSE", "BJ"):
        return "BJ"
    return None


def _yyyymmdd(value: str) -> date | None:
    if not value or len(value) != 8:
        return None
    try:
        return date(int(value[0:4]), int(value[4:6]), int(value[6:8]))
    except ValueError:
        return None


def _decimal(value: object) -> Decimal:
    if value is None or value == "":
        return Decimal(0)
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001
        return Decimal(0)
