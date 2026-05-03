"""Unit tests for compute_ma / compute_pct_chg."""

from __future__ import annotations

from decimal import Decimal

import pytest
from quant_core.domain.rules.ma import compute_ma, compute_pct_chg
from quant_core.errors import QuantError


@pytest.mark.unit
def test_compute_ma_window_one_returns_input() -> None:
    values = [Decimal(x) for x in ("1", "2", "3")]
    assert compute_ma(values, 1) == values


@pytest.mark.unit
def test_compute_ma_window_larger_than_input_all_none() -> None:
    values = [Decimal("1"), Decimal("2")]
    assert compute_ma(values, 5) == [None, None]


@pytest.mark.unit
def test_compute_ma_window_equals_len_one_value() -> None:
    values = [Decimal("1"), Decimal("2"), Decimal("3")]
    out = compute_ma(values, 3)
    assert out == [None, None, Decimal("2")]


@pytest.mark.unit
def test_compute_ma_window_lt_one_raises() -> None:
    with pytest.raises(QuantError, match="window must be >= 1"):
        compute_ma([Decimal("1")], 0)


@pytest.mark.unit
def test_compute_ma_empty_returns_empty() -> None:
    assert compute_ma([], 5) == []


@pytest.mark.unit
def test_compute_ma_decimal_precision_preserved() -> None:
    values = [Decimal("1.123456789") for _ in range(5)]
    out = compute_ma(values, 5)
    assert out[-1] == Decimal("1.123456789")


@pytest.mark.unit
def test_compute_pct_chg_basic() -> None:
    values = [Decimal("10"), Decimal("11"), Decimal("12.1")]
    out = compute_pct_chg(values)
    assert out[0] is None
    assert out[1] == Decimal("0.1")
    assert out[2] == Decimal("0.1")


@pytest.mark.unit
def test_compute_pct_chg_zero_prev_yields_none() -> None:
    values = [Decimal("0"), Decimal("5")]
    out = compute_pct_chg(values)
    assert out == [None, None]


@pytest.mark.unit
def test_compute_pct_chg_empty_returns_empty() -> None:
    assert compute_pct_chg([]) == []
