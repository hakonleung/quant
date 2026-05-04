"""Pure derivations from :class:`StockMeta` + latest close price.

Used by the snapshot Flight op (`list_stock_snapshots`) to produce the
list-view payload without writing derivative ratios into parquet. Every
formula is documented in ``docs/modules/01-stock-meta.md`` §2.1; this
module is the **single source of truth** for the口径 — any UI / analytics
caller must go through it instead of re-implementing.

Design rules:
    - Pure: no IO, no logging, no clock; takes inputs, returns
      :class:`DerivedMetrics`.
    - Permissive on inputs: any missing field / non-positive denominator
      → that metric is ``None``. Callers that need "x or default" wrap
      the call themselves.
    - Decimal end-to-end: never coerce through ``float`` to avoid silent
      precision loss on quantities like total_share * price.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from quant_core.domain.types.stock import QuarterlyFinancials, StockMeta


@dataclass(frozen=True, slots=True)
class DerivedMetrics:
    """Price-derived list-view metrics. Each field is ``None`` when any
    input is missing or any denominator is ≤ 0."""

    mkt_cap: Decimal | None
    float_mkt_cap: Decimal | None
    pe_ttm: Decimal | None
    pe_dynamic: Decimal | None
    pb: Decimal | None
    peg: Decimal | None
    gross_margin_ttm: Decimal | None


_EMPTY: DerivedMetrics = DerivedMetrics(
    mkt_cap=None,
    float_mkt_cap=None,
    pe_ttm=None,
    pe_dynamic=None,
    pb=None,
    peg=None,
    gross_margin_ttm=None,
)


def derive_metrics(meta: StockMeta, price: Decimal | None) -> DerivedMetrics:
    """Compute the list-view derived metrics.

    Args:
        meta: Fully or partially populated stock meta.
        price: Latest forward-adjusted close (`close_qfq`) for the same
            ``code``, or ``None`` when the kline cache has nothing.

    Returns:
        :class:`DerivedMetrics` with every field nullable. ``None`` price
        propagates to every metric; populated price still leaves
        financial-dependent metrics ``None`` until enrichment lands.
    """
    if price is None or price <= 0:
        return _EMPTY

    mkt_cap = _mul(meta.total_share, price)
    float_mkt_cap = _mul(meta.float_share, price)

    pe_ttm = _safe_div(mkt_cap, _sum_net_profit(meta.quarterlies, -4, None))
    pe_dynamic = _pe_dynamic(meta, mkt_cap)
    pb = _safe_div(mkt_cap, meta.net_assets)
    peg = _peg(meta, pe_ttm)
    gross_margin = _gross_margin_ttm(meta.quarterlies)

    return DerivedMetrics(
        mkt_cap=mkt_cap,
        float_mkt_cap=float_mkt_cap,
        pe_ttm=pe_ttm,
        pe_dynamic=pe_dynamic,
        pb=pb,
        peg=peg,
        gross_margin_ttm=gross_margin,
    )


# -- helpers ----------------------------------------------------------------


def _mul(a: Decimal | None, b: Decimal | None) -> Decimal | None:
    if a is None or b is None:
        return None
    if a <= 0 or b <= 0:
        return None
    return a * b


def _safe_div(numerator: Decimal | None, denominator: Decimal | None) -> Decimal | None:
    if numerator is None or denominator is None:
        return None
    if denominator <= 0:
        return None
    return numerator / denominator


def _sum_net_profit(
    quarters: tuple[QuarterlyFinancials, ...], start: int, stop: int | None
) -> Decimal | None:
    """Sum ``net_profit`` over ``quarters[start:stop]``.

    Returns ``None`` when fewer than 4 quarters fall in the window or
    any quarter is missing ``net_profit``. ``slice`` was the natural
    fit but mypy --strict rejects bare ``slice`` as ``slice[Any]``;
    int boundaries keep the typing explicit.
    """
    chunk = quarters[start:stop] if stop is not None else quarters[start:]
    if len(chunk) < 4:
        return None
    total = Decimal(0)
    for q in chunk:
        if q.net_profit is None:
            return None
        total += q.net_profit
    return total


def _pe_dynamic(meta: StockMeta, mkt_cap: Decimal | None) -> Decimal | None:
    """EastMoney-style 动态 PE.

    Annualises the latest quarter's net profit using ``net_profit *
    4 / quarter_index``, where ``quarter_index ∈ {1,2,3,4}`` is derived
    from ``period.month`` (3→1, 6→2, 9→3, 12→4). The choice of口径 is
    documented in ``docs/modules/01-stock-meta.md`` §2.1 and §9; do not
    inline an alternative here.
    """
    if mkt_cap is None or not meta.quarterlies:
        return None
    latest = meta.quarterlies[-1]
    if latest.net_profit is None or latest.net_profit <= 0:
        return None
    quarter_index = _quarter_index(latest.period.month)
    if quarter_index is None:
        return None
    annualised = latest.net_profit * Decimal(4) / Decimal(quarter_index)
    if annualised <= 0:
        return None
    return mkt_cap / annualised


def _peg(meta: StockMeta, pe_ttm: Decimal | None) -> Decimal | None:
    """PEG using TTM-vs-prior-TTM growth on net_profit.

    Needs ≥ 8 reporting periods for a clean YoY comparison; fewer
    quarters / negative prior-period TTM / non-positive growth all
    propagate to ``None``.
    """
    if pe_ttm is None or len(meta.quarterlies) < 8:
        return None
    recent = _sum_net_profit(meta.quarterlies, -4, None)
    prior = _sum_net_profit(meta.quarterlies, -8, -4)
    if recent is None or prior is None or prior <= 0:
        return None
    growth_pct = (recent - prior) / prior * Decimal(100)
    if growth_pct <= 0:
        return None
    return pe_ttm / growth_pct


def _gross_margin_ttm(
    quarters: tuple[QuarterlyFinancials, ...],
) -> Decimal | None:
    if len(quarters) < 4:
        return None
    chunk = quarters[-4:]
    rev_total = Decimal(0)
    cost_total = Decimal(0)
    for q in chunk:
        if q.revenue is None or q.operating_cost is None:
            return None
        rev_total += q.revenue
        cost_total += q.operating_cost
    if rev_total <= 0:
        return None
    return (rev_total - cost_total) / rev_total


def _quarter_index(month: int) -> int | None:
    """Map a quarter-end month to its 1-indexed quarter number."""
    return {3: 1, 6: 2, 9: 3, 12: 4}.get(month)
