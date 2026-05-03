"""Unit tests for Decimal quantisation helpers."""

from __future__ import annotations

from decimal import Decimal

import pytest
from quant_core.domain.pure.decimal import (
    quantize_amount,
    quantize_factor,
    quantize_price,
    quantize_rate,
)


@pytest.mark.unit
def test_quantize_price_4dp() -> None:
    assert quantize_price(Decimal("1.123456")) == Decimal("1.1235")


@pytest.mark.unit
def test_quantize_amount_2dp() -> None:
    assert quantize_amount(Decimal("100.555")) == Decimal("100.56")


@pytest.mark.unit
def test_quantize_rate_6dp() -> None:
    assert quantize_rate(Decimal("0.00012345678")) == Decimal("0.000123")


@pytest.mark.unit
def test_quantize_factor_4dp_round_half_up() -> None:
    assert quantize_factor(Decimal("1.23455")) == Decimal("1.2346")
