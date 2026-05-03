"""Assemble :class:`DailyBar` rows from raw bars + adj_factors.

Pure: composes :func:`compute_qfq_prices`, :func:`compute_ma` (x4) and
:func:`compute_pct_chg` then stitches the columns onto :class:`DailyBar`.
Quantisation runs at the boundary so the in-memory ``DailyBar`` matches
exactly what the parquet file stores.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from quant_core.domain.pure.decimal import (
    quantize_amount,
    quantize_factor,
    quantize_price,
    quantize_rate,
)
from quant_core.domain.rules.ma import compute_ma, compute_pct_chg
from quant_core.domain.rules.qfq import compute_qfq_prices
from quant_core.domain.types.kline import DailyBar

if TYPE_CHECKING:
    from collections.abc import Sequence
    from decimal import Decimal

    from quant_core.domain.types.kline import AdjFactor, RawDailyBar


_MA_WINDOWS: Final[tuple[int, ...]] = (5, 10, 20, 60)


def assemble_daily_bars(
    raw_bars: Sequence[RawDailyBar],
    adj_factors: Sequence[AdjFactor],
) -> list[DailyBar]:
    """Stitch qfq + MA + pct_chg onto raw bars and return :class:`DailyBar` rows.

    ``raw_bars`` must be sorted ascending by ``trade_date`` and all
    belong to the same code (assumption — not re-validated here; the
    upstream service guards that).
    """
    if not raw_bars:
        return []
    qfq = compute_qfq_prices(raw_bars, adj_factors)
    close_qfq_series: list[Decimal] = [q[3] for q in qfq]
    mas: dict[int, list[Decimal | None]] = {w: compute_ma(close_qfq_series, w) for w in _MA_WINDOWS}
    pct_chg = compute_pct_chg(close_qfq_series)
    out: list[DailyBar] = []
    for i, bar in enumerate(raw_bars):
        open_qfq, high_qfq, low_qfq, close_qfq, factor = qfq[i]
        out.append(
            DailyBar(
                code=bar.code,
                trade_date=bar.trade_date,
                open=quantize_price(bar.open),
                high=quantize_price(bar.high),
                low=quantize_price(bar.low),
                close=quantize_price(bar.close),
                volume=bar.volume,
                amount=quantize_amount(bar.amount),
                turnover_rate=quantize_rate(bar.turnover_rate),
                open_qfq=quantize_price(open_qfq),
                high_qfq=quantize_price(high_qfq),
                low_qfq=quantize_price(low_qfq),
                close_qfq=quantize_price(close_qfq),
                ma5=_q_or_none(mas[5][i]),
                ma10=_q_or_none(mas[10][i]),
                ma20=_q_or_none(mas[20][i]),
                ma60=_q_or_none(mas[60][i]),
                pct_chg_qfq=_q_rate_or_none(pct_chg[i]),
                adj_factor=quantize_factor(factor),
            )
        )
    return out


def _q_or_none(v: Decimal | None) -> Decimal | None:
    return None if v is None else quantize_price(v)


def _q_rate_or_none(v: Decimal | None) -> Decimal | None:
    return None if v is None else quantize_rate(v)
