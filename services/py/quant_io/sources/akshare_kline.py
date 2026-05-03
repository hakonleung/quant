"""AKShare-backed :class:`KlineSource`.

Uses ``ak.stock_zh_a_daily`` (sina backend) twice:

* ``adjust=""`` — un-adjusted OHLCV + ``amount`` (元) + ``turnover``
  (already a fraction). Volumes come back in shares.
* ``adjust="qfq-factor"`` — one row **per ex-dividend / split date** with
  the cumulative QFQ factor in effect from that date onward, anchored at
  the most recent trading day (``factor=1.0`` at present, factor > 1.0
  going back in time). The qfq formula is ``qfq[t] = raw[t] / factor[t]``
  (see :func:`quant_core.domain.rules.qfq.compute_qfq_prices`).
  We re-emit the most-recent-prior factor at the requested window's
  lower bound so qfq computation has a baseline entry even when no
  ex-div day falls inside the range.

Why QFQ-factor and not HFQ-factor: HFQ is anchored at IPO and the
absolute factor magnitude depends on every ex-div from IPO onward —
even those outside our 2024-09-20+ window. QFQ is anchored at the
present, so factor values are bounded and the computation is robust
against the windowed start.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Final, Literal, Protocol, runtime_checkable

from quant_core.domain.types.kline import AdjFactor, RawDailyBar
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


@runtime_checkable
class _AkshareGateway(Protocol):
    """Duck-typed view of the akshare module endpoints we need."""

    def stock_zh_a_daily(
        self,
        symbol: str,
        start_date: str,
        end_date: str,
        adjust: str,
    ) -> object: ...


class AKShareKlineSource:
    """K-line source adapter backed by AKShare's free endpoints."""

    __slots__ = ("_gateway",)

    def __init__(self, *, gateway: _AkshareGateway | None = None) -> None:
        self._gateway = gateway

    @property
    def name(self) -> str:
        return _NAME

    def healthcheck(self) -> SourceHealth:
        gw, reason = self._resolve_gateway()
        if gw is None:
            return health_unavailable(_NAME, reason or "unknown failure")
        return health_ok(_NAME)

    def fetch_range(self, code: str, start: date, end: date) -> Iterable[RawDailyBar]:
        gw = self._require_gateway()
        prefix = _exchange_prefix(code)
        if prefix is None:
            return
        symbol = f"{prefix}{code}"
        try:
            raw = gw.stock_zh_a_daily(
                symbol=symbol,
                start_date=_yyyymmdd(start),
                end_date=_yyyymmdd(end),
                adjust="",
            )
        except Exception as exc:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: stock_zh_a_daily({symbol}) failed: {exc}",
                {"source": _NAME, "symbol": symbol, "exc_type": type(exc).__name__},
            ) from exc
        for row in _iter_rows(raw):
            bar = _daily_row_to_bar(code, row)
            if bar is not None:
                yield bar

    def fetch_adj_factors(self, code: str, start: date, end: date) -> Iterable[AdjFactor]:
        gw = self._require_gateway()
        prefix = _exchange_prefix(code)
        if prefix is None:
            return
        symbol = f"{prefix}{code}"
        try:
            raw = gw.stock_zh_a_daily(
                symbol=symbol,
                start_date=_yyyymmdd(start),
                end_date=_yyyymmdd(end),
                adjust="qfq-factor",
            )
        except Exception as exc:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: stock_zh_a_daily({symbol}) failed: {exc}",
                {"source": _NAME, "symbol": symbol, "exc_type": type(exc).__name__},
            ) from exc
        rows = list(_iter_rows(raw))
        yield from _select_factors_in_window(code, rows, start, end)

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

    def _require_gateway(self) -> _AkshareGateway:
        gw, reason = self._resolve_gateway()
        if gw is None:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"{_NAME}: {reason or 'unavailable'}",
                {"source": _NAME},
            )
        return gw


# -- helpers ------------------------------------------------------------


def _iter_rows(raw: object) -> list[Mapping[str, object]]:
    to_dict = getattr(raw, "to_dict", None)
    if callable(to_dict):
        records = to_dict("records")
        if isinstance(records, list):
            return records
    if isinstance(raw, list):
        return raw
    raise TypeError(f"akshare returned unsupported container: {type(raw).__name__}")


def _daily_row_to_bar(code: str, row: Mapping[str, object]) -> RawDailyBar | None:
    """Translate a sina-shaped row into a :class:`RawDailyBar`.

    Sina's ``stock_zh_a_daily`` returns ``volume`` already in shares and
    ``turnover`` already as a fraction (0.005 = 0.5%). ``date`` is a
    plain :class:`date`; ``amount`` is in CNY.
    """
    trade_date = _coerce_date(row.get("date"))
    if trade_date is None:
        return None
    try:
        return RawDailyBar(
            code=code,
            trade_date=trade_date,
            open=_to_decimal(row.get("open")),
            high=_to_decimal(row.get("high")),
            low=_to_decimal(row.get("low")),
            close=_to_decimal(row.get("close")),
            volume=int(_to_decimal(row.get("volume"))),
            amount=_to_decimal(row.get("amount")),
            turnover_rate=_to_decimal(row.get("turnover")),
        )
    except (ValueError, ArithmeticError):
        return None


def _factor_row_to_af(code: str, row: Mapping[str, object]) -> AdjFactor | None:
    trade_date = _coerce_date(row.get("date"))
    factor_raw = row.get("qfq_factor")
    if trade_date is None or factor_raw is None:
        return None
    try:
        factor = _to_decimal(factor_raw)
    except (ValueError, ArithmeticError):
        return None
    if factor <= 0:
        return None
    return AdjFactor(code=code, trade_date=trade_date, factor=factor)


def _select_factors_in_window(
    code: str, rows: list[Mapping[str, object]], start: date, end: date
) -> list[AdjFactor]:
    """Anchor a baseline factor at ``start`` and return [start, end] entries.

    qfq computation requires a factor effective on every bar inside the
    window. The source emits one row per ex-div day, so we:

    1. Take any rows that already fall inside ``[start, end]``.
    2. Prepend the most-recent factor with ``trade_date <= start`` (re-
       anchored to ``start`` so the resolver lights up on the first bar).
    3. If ``start`` precedes every recorded factor, fall back to the
       earliest factor (still re-anchored to ``start``).
    """
    in_window: list[AdjFactor] = []
    for row in rows:
        af = _factor_row_to_af(code, row)
        if af is not None and start <= af.trade_date <= end:
            in_window.append(af)
    needs_baseline = not in_window or in_window[0].trade_date > start
    emitted = list(in_window)
    if needs_baseline:
        baseline = _factor_at_or_before(code, rows, start) or _factor_at_or_after(code, rows)
        if baseline is not None:
            emitted.append(AdjFactor(code=code, trade_date=start, factor=baseline.factor))
    emitted.sort(key=lambda af: af.trade_date)
    return emitted


def _factor_at_or_before(
    code: str, rows: list[Mapping[str, object]], target: date
) -> AdjFactor | None:
    """Most recent factor with ``trade_date <= target`` (or ``None``)."""
    best: AdjFactor | None = None
    for row in rows:
        af = _factor_row_to_af(code, row)
        if af is None or af.trade_date > target:
            continue
        if best is None or af.trade_date > best.trade_date:
            best = af
    if best is None:
        return None
    # Anchor onto the window start so the resolver's "latest <= target"
    # rule lights up immediately for the first bar.
    return AdjFactor(code=code, trade_date=target, factor=best.factor)


def _factor_at_or_after(code: str, rows: list[Mapping[str, object]]) -> AdjFactor | None:
    """Earliest factor row, regardless of date — last-resort baseline."""
    best: AdjFactor | None = None
    for row in rows:
        af = _factor_row_to_af(code, row)
        if af is None:
            continue
        if best is None or af.trade_date < best.trade_date:
            best = af
    return best


def _coerce_date(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value).date()
        except ValueError:
            return None
    # pandas.Timestamp duck-types `.date()`.
    to_date = getattr(value, "date", None)
    if callable(to_date):
        try:
            res = to_date()
        except Exception:  # noqa: BLE001 — defensive at adapter boundary
            return None
        if isinstance(res, date):
            return res
    return None


def _to_decimal(value: object) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if value is None:
        raise ValueError("missing decimal value")
    if isinstance(value, bool):
        raise ValueError("bool is not a numeric value")
    if isinstance(value, (int, float, str)):
        text = str(value).strip()
        if not text or text.lower() == "nan":
            raise ValueError("nan / empty decimal value")
        return Decimal(text)
    raise ValueError(f"unsupported decimal source: {type(value).__name__}")


def _yyyymmdd(d: date) -> str:
    return d.strftime("%Y%m%d")


def _is_valid_code(code: str) -> bool:
    return code.isdigit() and len(code) == 6


_ExchangePrefix = Literal["sh", "sz", "bj"]


def _exchange_prefix(code: str) -> _ExchangePrefix | None:
    if not _is_valid_code(code):
        return None
    if code.startswith("920"):
        return "bj"
    if code.startswith(("60", "68", "900")):
        return "sh"
    if code.startswith(("00", "30", "20")):
        return "sz"
    if code.startswith(("4", "8")):
        return "bj"
    return None
