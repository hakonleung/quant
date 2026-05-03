"""Forward-adjustment (前复权) computation (modules/02-stock-kline.md §5).

Pure function over ``(raw_bars, adj_factors)``: produces qfq prices
(open/high/low/close) using the formula::

    qfq_price[t] = raw_price[t] * adj_factor[t] / adj_factor[latest]

where ``adj_factor[latest]`` is the factor on the most recent date in
``adj_factors``. The latest factor cancels itself, so the most recent
qfq price equals the raw price — qfq only rewrites history backwards.

Inputs and output are ordered by ``trade_date`` ascending. Sorting is
the caller's responsibility — the function asserts monotonicity to fail
loudly on a misordered input rather than silently producing nonsense.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date
    from decimal import Decimal

    from quant_core.domain.types.kline import AdjFactor, RawDailyBar


def build_factor_map(adj_factors: Sequence[AdjFactor]) -> tuple[dict[date, Decimal], Decimal]:
    """Index adj_factors by trade_date and return ``(map, latest_factor)``.

    Raises:
        QuantError: ``EVALUATION_FAILED`` when ``adj_factors`` is empty
            or contains a non-positive factor.
    """
    if not adj_factors:
        raise QuantError(
            "EVALUATION_FAILED",
            "compute_qfq_prices requires at least one adj_factor",
        )
    factor_map: dict[date, Decimal] = {}
    latest_date: date | None = None
    for af in adj_factors:
        if af.factor <= 0:
            raise QuantError(
                "EVALUATION_FAILED",
                f"non-positive adj_factor for {af.code} on {af.trade_date}",
                {"code": af.code, "trade_date": af.trade_date.isoformat()},
            )
        factor_map[af.trade_date] = af.factor
        if latest_date is None or af.trade_date > latest_date:
            latest_date = af.trade_date
    assert latest_date is not None  # adj_factors non-empty
    return factor_map, factor_map[latest_date]


def _resolve_factor(
    factor_map: dict[date, Decimal],
    sorted_keys: list[date],
    target: date,
) -> Decimal:
    """Return the factor effective on ``target`` (latest <= target).

    A股 factors only change on ex-dividend days; for any other day the
    most recent prior factor is in effect. If ``target`` precedes every
    factor entry, fall back to the earliest known factor.
    """
    # Linear scan is fine: factor_map is small (one entry per ex-div day,
    # ~10 over the whole 2024-09-20 window for any single stock).
    chosen = sorted_keys[0]
    for d in sorted_keys:
        if d <= target:
            chosen = d
        else:
            break
    return factor_map[chosen]


def compute_qfq_prices(
    bars: Sequence[RawDailyBar],
    adj_factors: Sequence[AdjFactor],
) -> list[tuple[Decimal, Decimal, Decimal, Decimal, Decimal]]:
    """Compute ``(open_qfq, high_qfq, low_qfq, close_qfq, factor)`` per bar.

    Order matches ``bars``. Caller is responsible for stitching the
    output back onto :class:`DailyBar` (alongside MA + pct_chg).

    Raises:
        QuantError: ``EVALUATION_FAILED`` for non-positive prices,
            empty / non-positive adj_factors, or non-ascending bar dates.
    """
    factor_map, latest = build_factor_map(adj_factors)
    sorted_factor_keys = sorted(factor_map.keys())
    out: list[tuple[Decimal, Decimal, Decimal, Decimal, Decimal]] = []
    prev_date = None
    for bar in bars:
        if prev_date is not None and bar.trade_date <= prev_date:
            raise QuantError(
                "EVALUATION_FAILED",
                "bars must be sorted ascending by trade_date",
                {"code": bar.code, "trade_date": bar.trade_date.isoformat()},
            )
        prev_date = bar.trade_date
        if bar.open <= 0 or bar.high <= 0 or bar.low <= 0 or bar.close <= 0:
            raise QuantError(
                "EVALUATION_FAILED",
                f"non-positive raw price for {bar.code} on {bar.trade_date}",
                {"code": bar.code, "trade_date": bar.trade_date.isoformat()},
            )
        factor = _resolve_factor(factor_map, sorted_factor_keys, bar.trade_date)
        ratio = factor / latest
        out.append(
            (
                bar.open * ratio,
                bar.high * ratio,
                bar.low * ratio,
                bar.close * ratio,
                factor,
            )
        )
    return out
