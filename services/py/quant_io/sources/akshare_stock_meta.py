"""AKShare-backed :class:`StockMetaSource`.

**Default primary** stock-meta source (priority=1) — no token required.

Two upstream endpoints are used together:

* ``ak.stock_info_a_code_name()`` — bulk listing of every A-share code +
  name. Fast (~5500 rows in ~10s); the only call ``fetch_all()`` makes.
  Industry / share counts are not exposed by this endpoint.
* ``ak.stock_individual_basic_info_xq(symbol)`` — per-code "company
  basic info" snapshot from xueqiu, including ``affiliate_industry``,
  ``listed_date``, and the company-name fields. Slow (one HTTP RTT per
  code), so it powers ``fetch_one()`` for enrichment but is **not**
  invoked from ``fetch_all()``. The sync workflow calls ``fetch_one()``
  on demand (e.g. in an ``--enrich`` pass) for the codes that need it.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Final, Literal, Protocol, runtime_checkable
from zoneinfo import ZoneInfo

from quant_core.domain.types.stock import StockMeta
from quant_core.errors import QuantError

from quant_io.pinyin import name_to_pinyin_initials
from quant_io.sources._common import (
    health_ok,
    health_unavailable,
    lazy_import,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from quant_core.domain.types.source import SourceHealth


_NAME: Final[str] = "akshare"
# A-share trading days are in Beijing time; XQ encodes ``listed_date``
# as the epoch-ms of midnight Beijing time, so decoding via UTC would
# slip the date by one for many listings.
_BEIJING_TZ: Final[ZoneInfo] = ZoneInfo("Asia/Shanghai")
# Sole source for now (Tushare adapter was removed). Kept configurable
# so future sources can slot in front or behind without touching this
# file.
_DEFAULT_PRIORITY: Final[int] = 1
# Stand-in list_date for partial records (fetch_all only); fetch_one
# overlays the real listed_date when XQ is reachable.
_PARTIAL_LIST_DATE: Final[date] = date(1990, 1, 1)


@runtime_checkable
class _AkshareGateway(Protocol):
    """Duck-typed view of the akshare module.

    Real `ak.stock_info_a_code_name()` returns a ``pandas.DataFrame``;
    real `ak.stock_individual_basic_info_xq(symbol=...)` returns a
    DataFrame with one ``item``/``value`` row per field. Both are
    normalised to plain mappings via :func:`_iter_rows` so this module
    has no pandas import in its public surface.
    """

    def stock_info_a_code_name(self) -> object: ...

    def stock_individual_basic_info_xq(self, symbol: str) -> object: ...


class AKShareStockMetaSource:
    """Default-primary stock-meta source backed by AKShare."""

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
            meta = _basic_row_to_meta(row, now)
            if meta is not None:
                yield meta

    def fetch_one(self, code: str) -> StockMeta | None:
        gw, reason = self._resolve_gateway()
        if gw is None:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: {reason or 'unavailable'}",
                {"source": _NAME},
            )
        if not _is_valid_code(code):
            return None
        # XQ wants the exchange-prefixed symbol form (e.g. "SH600519"); the
        # exchange is derived from the code prefix purely as transport
        # plumbing — the resulting `StockMeta` does not carry it.
        exchange = _exchange_for_code(code)
        if exchange is None:
            return None
        symbol = f"{exchange}{code}"
        try:
            raw = gw.stock_individual_basic_info_xq(symbol=symbol)
        except Exception as exc:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: stock_individual_basic_info_xq({symbol}) failed: {exc}",
                {"source": _NAME, "symbol": symbol, "exc_type": type(exc).__name__},
            ) from exc
        fields = _xq_rows_to_fields(_iter_rows(raw))
        if not fields:
            return None
        return _xq_fields_to_meta(code, fields, datetime.now(tz=UTC))

    # -- internals ------------------------------------------------------

    def _resolve_gateway(self) -> tuple[_AkshareGateway | None, str | None]:
        if self._gateway is not None:
            return self._gateway, None
        ak = lazy_import("akshare")
        if ak is None:
            return None, "akshare package not installed"
        if not isinstance(ak, _AkshareGateway):
            return None, "akshare module missing required endpoints"
        self._gateway = ak
        return ak, None


# -- helpers ------------------------------------------------------------


def _iter_rows(raw: object) -> Iterable[Mapping[str, object]]:
    """Normalise pandas-DataFrame and list-of-dict gateways into a row stream.

    AKShare endpoints hand back ``pandas.DataFrame`` at runtime; tests
    pass plain ``list[dict]``. Duck-type via ``to_dict("records")``
    without importing pandas.
    """
    to_dict = getattr(raw, "to_dict", None)
    if callable(to_dict):
        records = to_dict("records")
        if isinstance(records, list):
            return records
    if isinstance(raw, list):
        return raw
    raise TypeError(f"akshare returned unsupported container: {type(raw).__name__}")


def _basic_row_to_meta(row: Mapping[str, object], now: datetime) -> StockMeta | None:
    """Map a `stock_info_a_code_name` row into a partial :class:`StockMeta`.

    ``code`` is the bare 6-digit string. We still validate the prefix via
    :func:`_exchange_for_code` to drop rows that look like A-share codes
    but aren't (e.g. preference shares, indices). ``industries`` is empty;
    ``list_date`` is the partial sentinel; share counts are 0. The sync
    workflow can overlay these with `fetch_one()` when enrichment is
    desired.
    """
    code = _str(row.get("code"))
    name = _str(row.get("name"))
    if not code or not name or not _is_valid_code(code):
        return None
    if _exchange_for_code(code) is None:
        return None
    return StockMeta(
        code=code,
        name=name,
        name_pinyin=name_to_pinyin_initials(name),
        industries="",
        list_date=_PARTIAL_LIST_DATE,
        # Bulk endpoint does not expose share-count breakdown; assume the
        # full equity is tradable until enrichment refines it.
        float_pct=Decimal(1),
        updated_at=now,
    )


def _xq_rows_to_fields(rows: Iterable[Mapping[str, object]]) -> dict[str, object]:
    """Pivot the XQ ``[{item, value}, ...]`` shape into a single dict."""
    out: dict[str, object] = {}
    for row in rows:
        key = row.get("item")
        if isinstance(key, str):
            out[key] = row.get("value")
    return out


def _xq_fields_to_meta(code: str, fields: Mapping[str, object], now: datetime) -> StockMeta | None:
    """Build a :class:`StockMeta` from the XQ field dict."""
    name = _str(fields.get("org_short_name_cn")) or _str(fields.get("org_name_cn"))
    if not name:
        return None
    industry_name = _xq_industry_name(fields.get("affiliate_industry"))
    list_date = _epoch_ms_to_date(fields.get("listed_date")) or _PARTIAL_LIST_DATE
    return StockMeta(
        code=code,
        name=name,
        name_pinyin=name_to_pinyin_initials(name),
        industries=industry_name,
        list_date=list_date,
        # XQ does not expose a separate restricted-share count; the
        # ``actual_issue_vol`` it reports is the IPO float, not a current
        # ratio. Default to 1 (fully tradable) and let a future
        # share-structure enricher refine it.
        float_pct=Decimal(1),
        updated_at=now,
    )


def _xq_industry_name(value: object) -> str:
    """Pull the industry display name out of XQ's ``affiliate_industry`` cell.

    Real shape: ``{'ind_code': 'BK0088', 'ind_name': '白酒'}``. AKShare
    sometimes hands the whole dict as a value; sometimes (when no
    industry is recorded) it's ``None`` or ``"nan"``.
    """
    if isinstance(value, dict):
        name = value.get("ind_name")
        return _str(name)
    return ""


def _is_valid_code(code: str) -> bool:
    """Bare 6-digit A-share code (no exchange suffix)."""
    return code.isdigit() and len(code) == 6


_ExchangePrefix = Literal["SH", "SZ", "BJ"]


def _exchange_for_code(code: str) -> _ExchangePrefix | None:
    """Internal helper — derive the XQ symbol prefix from a bare code.

    Used **only** for two purposes inside this adapter:

    - Validating that a bare 6-digit string is a real A-share code
      (returns ``None`` for codes that don't fit a known prefix range,
      e.g. preference shares, indices).
    - Building the XQ symbol form ``{prefix}{code}`` (e.g. ``"SH600519"``)
      that ``ak.stock_individual_basic_info_xq`` requires as input.

    The exchange is **not** persisted on :class:`StockMeta`. Downstream
    consumers that need it can re-derive it from the code prefix.

    Prefix → exchange map (current as of 2026):

    - SH main board: ``60``
    - SH STAR (科创板): ``688``, ``689``
    - SH B-share: ``900``
    - SZ main: ``000``, ``001``, ``002``, ``003``
    - SZ ChiNext (创业板): ``300``, ``301``
    - BJ (北交所): ``43``, ``83``, ``87``, ``88``, ``920`` (added 2024)
    """
    if not _is_valid_code(code):
        return None
    if code.startswith("920"):
        return "BJ"
    if code.startswith(("60", "68", "900")):
        return "SH"
    if code.startswith(("00", "30", "20")):
        return "SZ"
    if code.startswith(("4", "8")):
        return "BJ"
    return None


def _str(value: object) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    # akshare/pandas serialise NaN cells as the literal string "nan"
    return "" if s.lower() == "nan" else s


def _epoch_ms_to_date(value: object) -> date | None:
    """XQ encodes timestamps as epoch-ms ints; tolerate floats and strings."""
    if value is None:
        return None
    if not isinstance(value, (int, float, str)):
        return None
    try:
        ms = int(float(value))
    except (TypeError, ValueError):
        return None
    if ms <= 0:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000.0, tz=_BEIJING_TZ).date()
    except (OverflowError, ValueError, OSError):
        return None
