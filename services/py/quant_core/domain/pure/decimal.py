"""Decimal quantisation helpers (modules/02-stock-kline.md §10).

All kline numeric columns are stored at fixed precision so the parquet
file is byte-stable across re-syncs and the serialised JSON over the
HTTP API does not jitter at the long tail.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Final

_PRICE_Q: Final[Decimal] = Decimal("0.0001")
_AMOUNT_Q: Final[Decimal] = Decimal("0.01")
_RATE_Q: Final[Decimal] = Decimal("0.000001")
_FACTOR_Q: Final[Decimal] = Decimal("0.0001")


def quantize_price(value: Decimal) -> Decimal:
    """Round a price (open/high/low/close/qfq/MA) to 4 decimal places."""
    return value.quantize(_PRICE_Q, rounding=ROUND_HALF_UP)


def quantize_amount(value: Decimal) -> Decimal:
    """Round a money amount to 2 decimal places (CNY yuan)."""
    return value.quantize(_AMOUNT_Q, rounding=ROUND_HALF_UP)


def quantize_rate(value: Decimal) -> Decimal:
    """Round a ratio (turnover, pct_chg) to 6 decimal places."""
    return value.quantize(_RATE_Q, rounding=ROUND_HALF_UP)


def quantize_factor(value: Decimal) -> Decimal:
    """Round an adjustment factor to 4 decimal places."""
    return value.quantize(_FACTOR_Q, rounding=ROUND_HALF_UP)
