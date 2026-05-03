"""Simple moving average over a Decimal series (modules/02-stock-kline.md §5)."""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence


def compute_ma(values: Sequence[Decimal], window: int) -> list[Decimal | None]:
    """Trailing simple moving average.

    Args:
        values: Decimal series ordered earliest → latest.
        window: Number of points in the trailing window. Must be >= 1.

    Returns:
        List of the same length as ``values``. The first ``window-1``
        entries are ``None`` (warm-up); subsequent entries are the
        arithmetic mean of the trailing ``window`` values.

    Raises:
        QuantError: ``INVALID_ARGUMENT`` for ``window < 1``.
    """
    if window < 1:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"window must be >= 1, got {window}",
        )
    n = len(values)
    out: list[Decimal | None] = [None] * n
    if n < window:
        return out
    running = sum(values[:window], Decimal(0))
    out[window - 1] = running / window
    for i in range(window, n):
        running = running + values[i] - values[i - window]
        out[i] = running / window
    return out


def compute_pct_chg(values: Sequence[Decimal]) -> list[Decimal | None]:
    """Period-over-period return on a Decimal series.

    Args:
        values: Close prices ordered earliest → latest.

    Returns:
        List of the same length. ``out[0]`` is ``None`` (no prior); each
        subsequent entry is ``(values[i] - values[i-1]) / values[i-1]``.
    """
    n = len(values)
    out: list[Decimal | None] = [None] * n
    for i in range(1, n):
        prev = values[i - 1]
        if prev == 0:
            out[i] = None
        else:
            out[i] = (values[i] - prev) / prev
    return out
