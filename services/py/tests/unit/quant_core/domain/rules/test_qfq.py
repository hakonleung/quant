"""Unit tests for compute_qfq_prices (modules/02-stock-kline.md §9.1)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from quant_core.domain.rules.qfq import compute_qfq_prices
from quant_core.domain.types.kline import AdjFactor, RawDailyBar
from quant_core.errors import QuantError


def _bar(
    code: str,
    d: date,
    open_: str = "10",
    high: str = "11",
    low: str = "9",
    close: str = "10.5",
) -> RawDailyBar:
    return RawDailyBar(
        code=code,
        trade_date=d,
        open=Decimal(open_),
        high=Decimal(high),
        low=Decimal(low),
        close=Decimal(close),
        volume=1000,
        amount=Decimal("10500"),
        turnover_rate=Decimal("0.01"),
    )


def _factor(code: str, d: date, factor: str) -> AdjFactor:
    return AdjFactor(code=code, trade_date=d, factor=Decimal(factor))


@pytest.mark.unit
def test_compute_qfq_single_factor_window_returns_raw_prices() -> None:
    bars = [_bar("600519", date(2024, 9, 20)), _bar("600519", date(2024, 9, 23))]
    factors = [_factor("600519", date(2024, 9, 20), "1.0")]
    out = compute_qfq_prices(bars, factors)
    # ratio = 1.0/1.0 = 1, qfq == raw
    assert out[0][3] == Decimal("10.5")
    assert out[1][3] == Decimal("10.5")
    assert out[0][4] == Decimal("1.0")


@pytest.mark.unit
def test_compute_qfq_multi_ex_div_history_rewrites_only_backwards() -> None:
    bars = [
        _bar("600519", date(2024, 9, 20), close="10"),
        _bar("600519", date(2024, 12, 20), close="20"),  # ex-div day
        _bar("600519", date(2025, 6, 26), close="30"),  # second ex-div
    ]
    factors = [
        _factor("600519", date(2024, 9, 20), "1.0"),
        _factor("600519", date(2024, 12, 20), "1.5"),
        _factor("600519", date(2025, 6, 26), "2.0"),
    ]
    out = compute_qfq_prices(bars, factors)
    latest = Decimal("2.0")
    assert out[0][3] == Decimal("10") * Decimal("1.0") / latest
    assert out[1][3] == Decimal("20") * Decimal("1.5") / latest
    assert out[2][3] == Decimal("30")  # latest factor self-cancels


@pytest.mark.unit
def test_compute_qfq_empty_factors_raises() -> None:
    with pytest.raises(QuantError, match="at least one adj_factor"):
        compute_qfq_prices([_bar("X", date(2024, 9, 20))], [])


@pytest.mark.unit
def test_compute_qfq_non_positive_factor_raises() -> None:
    with pytest.raises(QuantError, match="non-positive adj_factor"):
        compute_qfq_prices(
            [_bar("X", date(2024, 9, 20))],
            [_factor("X", date(2024, 9, 20), "0")],
        )


@pytest.mark.unit
def test_compute_qfq_non_positive_price_raises() -> None:
    bar = _bar("X", date(2024, 9, 20), close="0")
    with pytest.raises(QuantError, match="non-positive raw price"):
        compute_qfq_prices([bar], [_factor("X", date(2024, 9, 20), "1.0")])


@pytest.mark.unit
def test_compute_qfq_unsorted_bars_raise() -> None:
    bars = [_bar("X", date(2024, 9, 23)), _bar("X", date(2024, 9, 20))]
    factors = [_factor("X", date(2024, 9, 20), "1.0")]
    with pytest.raises(QuantError, match="ascending"):
        compute_qfq_prices(bars, factors)


@pytest.mark.unit
def test_compute_qfq_ratio_invariant_two_points() -> None:
    """Property: qfq[a]/qfq[b] == raw[a]/raw[b] for any pair when factor unchanged."""
    bars = [
        _bar("X", date(2024, 9, 20), close="10"),
        _bar("X", date(2024, 9, 23), close="12"),
    ]
    factors = [_factor("X", date(2024, 9, 20), "1.5")]
    out = compute_qfq_prices(bars, factors)
    assert out[0][3] / out[1][3] == bars[0].close / bars[1].close


@pytest.mark.unit
def test_compute_qfq_empty_bars_returns_empty() -> None:
    factors = [_factor("X", date(2024, 9, 20), "1.0")]
    assert compute_qfq_prices([], factors) == []
