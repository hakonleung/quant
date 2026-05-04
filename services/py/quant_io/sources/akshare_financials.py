"""AKShare-backed financial enrichment for :class:`StockMeta`.

Two collaborators (modules/01-stock-meta.md §3.1.2):

* :class:`AKShareFinancialsBulkSource` — pulls 9 calendar quarters of
  full-market 业绩报表 via ``ak.stock_yjbb_em(date=YYYYMMDD)`` and
  converts the YTD-cumulative figures into single-quarter values by
  subtracting prior-period YTD within the same fiscal year. Fast: 9
  HTTP RTTs cover 5500 stocks * 8 quarters of (revenue, net_profit,
  net_assets).
* :class:`AKShareFinancialsPerStockEnricher` — single-code slow-path
  that pulls the income-statement extras the bulk endpoint omits
  (``operating_cost``, ``net_profit_excl_nr``) via
  ``ak.stock_financial_abstract_ths``, plus share counts via
  ``ak.stock_individual_info_em``. Returns deltas a service layer can
  merge into the existing :class:`StockMeta`.

Both are duck-typed against the akshare module to keep the import lazy
and to make tests injectable with plain mappings.
"""

from __future__ import annotations

import logging
import time
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Final, Protocol, runtime_checkable

from quant_core.domain.types.stock import QuarterlyFinancials
from quant_core.errors import QuantError

from quant_io.sources._common import lazy_import

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping


_logger = logging.getLogger(__name__)

# How many calendar quarters back to pull from `stock_yjbb_em`. We need
# 9 to compute 8 *single-quarter* values cleanly: each non-Q1 period's
# single value = YTD - prior_quarter.YTD (same fiscal year), so the
# oldest Q1 in the buffer needs the period before it as a base anchor.
# Anchoring at 9 still keeps the call budget at 9 RTT / scan.
_BULK_QUARTERS: Final[int] = 9
# Quarters retained after YTD->single conversion (front of the truncate
# window discarded since we lack the prior anchor for the very oldest
# Q2/Q3/Q4 values).
_KEEP_QUARTERS: Final[int] = 8


@runtime_checkable
class _AkshareGateway(Protocol):
    def stock_yjbb_em(self, date: str) -> object: ...

    def stock_individual_info_em(self, symbol: str) -> object: ...

    def stock_financial_abstract_ths(self, symbol: str) -> object: ...


class FinancialsBulkPayload:
    """One stock's bulk-financials payload across many quarters.

    Attributes:
        code: 6-digit code.
        quarterlies: oldest → newest quarterly snapshots, **already
            converted from YTD to single-quarter** values for revenue
            and net_profit. ``operating_cost`` / ``net_profit_excl_nr``
            are always ``None`` here — bulk endpoint doesn't expose
            them.
        net_assets: latest period's net assets, as
            ``每股净资产 * total_share`` if total_share is known
            externally — bulk source can't fill it on its own. The
            bulk worker passes it through; the service layer joins
            with the meta repo's structural fields.
    """

    __slots__ = ("code", "net_assets_per_share", "net_assets_period", "quarterlies")

    def __init__(
        self,
        *,
        code: str,
        quarterlies: tuple[QuarterlyFinancials, ...],
        net_assets_per_share: Decimal | None,
        net_assets_period: date | None,
    ) -> None:
        self.code = code
        self.quarterlies = quarterlies
        self.net_assets_per_share = net_assets_per_share
        self.net_assets_period = net_assets_period


class AKShareFinancialsBulkSource:
    """Bulk 业绩报表 across N recent quarters, keyed by code.

    Args:
        gateway: Optional injection point (tests pass a fake exposing
            ``stock_yjbb_em``); production resolves akshare lazily.
    """

    __slots__ = ("_gateway",)

    def __init__(self, *, gateway: _AkshareGateway | None = None) -> None:
        self._gateway = gateway

    def fetch_recent(
        self, *, today: date, quarters: int = _KEEP_QUARTERS
    ) -> dict[str, FinancialsBulkPayload]:
        """Pull the last ``quarters`` calendar quarters' bulk reports.

        Args:
            today: Anchor date used to enumerate quarter ends; tests
                pass a fixed date for determinism.
            quarters: How many single-quarter values per code to keep.
                Must be ≤ {_KEEP_QUARTERS} = 8 (we always pull 9 to
                anchor the YTD→single subtraction).

        Returns:
            ``{code: FinancialsBulkPayload}``. Codes are emitted only
            when at least one period had a numeric net_profit; rows
            with all-null financials are dropped to keep the merge
            phase cheap.

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` when akshare isn't
                importable or every quarter call failed. Per-quarter
                failures are logged and skipped; only a complete-bust
                surfaces.
        """
        if quarters <= 0 or quarters > _KEEP_QUARTERS:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"quarters must be in (0, {_KEEP_QUARTERS}], got {quarters}",
            )
        gw = self._resolve_gateway()
        periods = _enumerate_quarter_ends(today, count=_BULK_QUARTERS)
        # Per-period frames: { code: { period: {revenue_ytd, np_ytd, eps_ba}}}.
        per_period: dict[date, dict[str, _PeriodCells]] = {}
        successes = 0
        # Per-period progress logging — each `stock_yjbb_em` call is a
        # blind 1-3s scrape against EastMoney; without this, a stuck
        # call looks like the whole bulk_refresh is hung. The first
        # log line goes out before the first call so an immediate hang
        # is also visible.
        _logger.info(
            "bulk_yjbb_start periods=%s",
            ",".join(p.isoformat() for p in periods),
        )
        for period in periods:
            t0 = time.monotonic()
            try:
                raw = gw.stock_yjbb_em(date=_period_to_yjbb_arg(period))
            except Exception as exc:  # noqa: BLE001 — adapter boundary
                _logger.warning(
                    "yjbb_em_failed period=%s elapsed_ms=%d err=%s",
                    period.isoformat(),
                    int((time.monotonic() - t0) * 1000),
                    _short_repr(exc),
                )
                continue
            cells = dict(_iter_yjbb_rows(raw))
            per_period[period] = cells
            successes += 1
            _logger.info(
                "yjbb_em_ok period=%s rows=%d elapsed_ms=%d",
                period.isoformat(),
                len(cells),
                int((time.monotonic() - t0) * 1000),
            )
        if successes == 0:
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                "akshare stock_yjbb_em failed for every period",
                {"periods_tried": [p.isoformat() for p in periods]},
            )
        return _build_payloads(periods, per_period, keep=quarters)

    def _resolve_gateway(self) -> _AkshareGateway:
        if self._gateway is not None:
            return self._gateway
        ak = lazy_import("akshare")
        if ak is None:
            raise QuantError(
                "SOURCE_UNAVAILABLE", "akshare package not installed"
            )
        if not isinstance(ak, _AkshareGateway):
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                "akshare module missing required endpoints",
            )
        self._gateway = ak
        return ak


class FinancialsEnrichmentDelta:
    """Per-stock fields filled by the slow per-stock enricher."""

    __slots__ = (
        "code",
        "float_share",
        "net_profit_excl_nr_by_period",
        "operating_cost_by_period",
        "total_share",
    )

    def __init__(
        self,
        *,
        code: str,
        total_share: Decimal | None,
        float_share: Decimal | None,
        operating_cost_by_period: dict[date, Decimal],
        net_profit_excl_nr_by_period: dict[date, Decimal],
    ) -> None:
        self.code = code
        self.total_share = total_share
        self.float_share = float_share
        self.operating_cost_by_period = operating_cost_by_period
        self.net_profit_excl_nr_by_period = net_profit_excl_nr_by_period


class AKShareFinancialsPerStockEnricher:
    """Per-code financial fill-in: total_share / float_share / 扣非 / 营业成本.

    Args:
        gateway: Optional duck-typed gateway exposing
            ``stock_individual_info_em`` and
            ``stock_financial_abstract_ths``. Production lazy-imports
            akshare.
    """

    __slots__ = ("_gateway",)

    def __init__(self, *, gateway: _AkshareGateway | None = None) -> None:
        self._gateway = gateway

    def fetch_for(self, code: str) -> FinancialsEnrichmentDelta | None:
        """Pull the slow-path fields for one ``code``.

        Returns ``None`` when both upstreams returned nothing (the
        common case for delisted / non-A-share rows that snuck into
        the universe). Otherwise the returned delta may have *some*
        fields filled and others ``None`` — callers merge keeping
        existing values when this delta's are absent.

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` when akshare isn't
                importable. Per-endpoint failures are logged and
                degraded (return whatever the other endpoint produced).
        """
        if not _is_valid_code(code):
            return None
        gw = self._resolve_gateway()
        total_share, float_share = self._fetch_share_counts(gw, code)
        op_cost, np_excl = self._fetch_ths(gw, code)
        if (
            total_share is None
            and float_share is None
            and not op_cost
            and not np_excl
        ):
            return None
        return FinancialsEnrichmentDelta(
            code=code,
            total_share=total_share,
            float_share=float_share,
            operating_cost_by_period=op_cost,
            net_profit_excl_nr_by_period=np_excl,
        )

    def _resolve_gateway(self) -> _AkshareGateway:
        if self._gateway is not None:
            return self._gateway
        ak = lazy_import("akshare")
        if ak is None:
            raise QuantError(
                "SOURCE_UNAVAILABLE", "akshare package not installed"
            )
        if not isinstance(ak, _AkshareGateway):
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                "akshare module missing required endpoints",
            )
        self._gateway = ak
        return ak

    def _fetch_share_counts(
        self, gw: _AkshareGateway, code: str
    ) -> tuple[Decimal | None, Decimal | None]:
        try:
            raw = gw.stock_individual_info_em(symbol=code)
        except Exception as exc:  # noqa: BLE001 — adapter boundary
            _logger.warning(
                "individual_info_em_failed code=%s err=%s",
                code,
                _short_repr(exc),
            )
            return (None, None)
        fields = _iter_item_value_rows(raw)
        return (
            _to_decimal(fields.get("总股本")),
            _to_decimal(fields.get("流通股")),
        )

    def _fetch_ths(
        self, gw: _AkshareGateway, code: str
    ) -> tuple[dict[date, Decimal], dict[date, Decimal]]:
        try:
            raw = gw.stock_financial_abstract_ths(symbol=code)
        except Exception as exc:  # noqa: BLE001 — adapter boundary
            _logger.warning(
                "financial_abstract_ths_failed code=%s err=%s",
                code,
                _short_repr(exc),
            )
            return ({}, {})
        op_cost: dict[date, Decimal] = {}
        np_excl: dict[date, Decimal] = {}
        for row in _iter_records(raw):
            period = _parse_period(row.get("报告期"))
            if period is None:
                continue
            cost = _to_decimal(row.get("营业成本"))
            if cost is not None:
                op_cost[period] = cost
            np = _to_decimal(row.get("扣非净利润"))
            if np is not None:
                np_excl[period] = np
        return (op_cost, np_excl)


# -- internal helpers --------------------------------------------------------


class _PeriodCells:
    __slots__ = ("eps_ba", "np_ytd", "revenue_ytd")

    def __init__(
        self,
        *,
        revenue_ytd: Decimal | None,
        np_ytd: Decimal | None,
        eps_ba: Decimal | None,
    ) -> None:
        self.revenue_ytd = revenue_ytd
        self.np_ytd = np_ytd
        self.eps_ba = eps_ba


def _enumerate_quarter_ends(today: date, *, count: int) -> list[date]:
    """The ``count`` quarter-ends strictly preceding ``today``.

    Ordered oldest → newest. ``today`` itself is never included even
    if it lands on 03-31 etc. — partial quarters before the report
    is officially out (晚于公告日) would leak an empty payload.
    """
    # Snap to the last completed quarter end relative to ``today``.
    # Q1 ends 03-31; we accept anchoring on it the day after.
    quarter_ends = [date(today.year, m, _last_day(today.year, m)) for m in (3, 6, 9, 12)]
    eligible = [d for d in quarter_ends if d < today]
    anchor = date(today.year - 1, 12, 31) if not eligible else eligible[-1]
    out: list[date] = []
    cur = anchor
    while len(out) < count:
        out.append(cur)
        cur = _previous_quarter_end(cur)
    out.reverse()
    return out


def _previous_quarter_end(d: date) -> date:
    if d.month == 3:
        return date(d.year - 1, 12, 31)
    return date(d.year, d.month - 3, _last_day(d.year, d.month - 3))


def _last_day(year: int, month: int) -> int:
    return {3: 31, 6: 30, 9: 30, 12: 31}[month]


def _period_to_yjbb_arg(period: date) -> str:
    """`stock_yjbb_em` wants ``YYYYMMDD`` of the period end."""
    return period.strftime("%Y%m%d")


def _iter_records(raw: object) -> list[Mapping[str, object]]:
    """Coerce pandas DataFrame / list[dict] → list of mappings."""
    to_dict = getattr(raw, "to_dict", None)
    if callable(to_dict):
        records = to_dict("records")
        if isinstance(records, list):
            return records
    if isinstance(raw, list):
        return raw
    return []


def _iter_yjbb_rows(raw: object) -> Iterable[tuple[str, _PeriodCells]]:
    for row in _iter_records(raw):
        code = _str(row.get("股票代码"))
        if not _is_valid_code(code):
            continue
        revenue = _to_decimal(row.get("营业总收入") or row.get("营业收入-营业收入"))
        net_profit = _to_decimal(row.get("净利润-净利润") or row.get("净利润"))
        eps_ba = _to_decimal(row.get("每股净资产"))
        if revenue is None and net_profit is None and eps_ba is None:
            continue
        yield code, _PeriodCells(revenue_ytd=revenue, np_ytd=net_profit, eps_ba=eps_ba)


def _iter_item_value_rows(raw: object) -> Mapping[str, object]:
    """Pivot ``[{item, value}, ...]`` into a dict; tolerant to schema noise."""
    out: dict[str, object] = {}
    for row in _iter_records(raw):
        key = row.get("item")
        if isinstance(key, str):
            out[key] = row.get("value")
    return out


def _build_payloads(
    periods: list[date],
    per_period: dict[date, dict[str, _PeriodCells]],
    *,
    keep: int,
) -> dict[str, FinancialsBulkPayload]:
    # Universe of codes: union across every period that succeeded.
    codes: set[str] = set()
    for table in per_period.values():
        codes.update(table.keys())
    if not codes:
        return {}
    out: dict[str, FinancialsBulkPayload] = {}
    for code in codes:
        single = _ytd_to_single_quarter(periods, per_period, code)
        if not single:
            continue
        # Trim the oldest entries; the YTD->single math left them with
        # no anchor in some cases (returned None in `_ytd_to_single_quarter`
        # for those rows already), so this is just a fallback cap.
        kept = single[-keep:] if len(single) > keep else single
        latest_eps = next(
            (
                cells.eps_ba
                for period in reversed(periods)
                for cells in [per_period.get(period, {}).get(code)]
                if cells is not None and cells.eps_ba is not None
            ),
            None,
        )
        latest_eps_period = next(
            (
                period
                for period in reversed(periods)
                for cells in [per_period.get(period, {}).get(code)]
                if cells is not None and cells.eps_ba is not None
            ),
            None,
        )
        out[code] = FinancialsBulkPayload(
            code=code,
            quarterlies=tuple(kept),
            net_assets_per_share=latest_eps,
            net_assets_period=latest_eps_period,
        )
    return out


def _ytd_to_single_quarter(
    periods: list[date],
    per_period: dict[date, dict[str, _PeriodCells]],
    code: str,
) -> list[QuarterlyFinancials]:
    """Convert each period's YTD revenue / net_profit to the standalone
    quarterly delta. Q1 is its own value; later quarters subtract the
    prior period within the same fiscal year. Missing prior anchor →
    skip that period (caller drops Nones at the front automatically).
    """
    out: list[QuarterlyFinancials] = []
    by_year: dict[int, dict[date, _PeriodCells]] = {}
    for p in periods:
        cells = per_period.get(p, {}).get(code)
        if cells is None:
            continue
        by_year.setdefault(p.year, {})[p] = cells
    for p in periods:
        cells = per_period.get(p, {}).get(code)
        if cells is None:
            continue
        if p.month == 3:
            revenue_q = cells.revenue_ytd
            np_q = cells.np_ytd
        else:
            prev = _prev_period_in_year(p, by_year)
            revenue_q = _diff(cells.revenue_ytd, prev.revenue_ytd) if prev is not None else None
            np_q = _diff(cells.np_ytd, prev.np_ytd) if prev is not None else None
        if revenue_q is None and np_q is None:
            continue
        out.append(
            QuarterlyFinancials(
                period=p,
                revenue=revenue_q,
                operating_cost=None,
                net_profit=np_q,
                net_profit_excl_nr=None,
            )
        )
    return out


def _prev_period_in_year(
    p: date, by_year: dict[int, dict[date, _PeriodCells]]
) -> _PeriodCells | None:
    """Predecessor quarter end in the same fiscal year."""
    months = {6: 3, 9: 6, 12: 9}
    prev_month = months.get(p.month)
    if prev_month is None:
        return None
    prev_date = date(p.year, prev_month, _last_day(p.year, prev_month))
    return by_year.get(p.year, {}).get(prev_date)


def _diff(a: Decimal | None, b: Decimal | None) -> Decimal | None:
    if a is None or b is None:
        return None
    return a - b


def _is_valid_code(code: str) -> bool:
    return code.isdigit() and len(code) == 6


def _str(value: object) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    return "" if s.lower() == "nan" else s


def _to_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() == "nan":
        return None
    # akshare sometimes encodes 万元 / 亿元 suffixes literally; reject
    # anything non-numeric rather than silently dropping precision.
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def _parse_period(value: object) -> date | None:
    s = _str(value)
    if not s:
        return None
    # Common shapes: "2025-09-30", "20250930", "2025/09/30".
    digits = "".join(ch for ch in s if ch.isdigit())
    if len(digits) >= 8:
        try:
            return date(int(digits[0:4]), int(digits[4:6]), int(digits[6:8]))
        except ValueError:
            return None
    return None


def _short_repr(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc!s}"[:200]
