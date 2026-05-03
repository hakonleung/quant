"""Pure pattern-matching primitives (modules/04-pattern-matching.md §3).

* :func:`z_score` — normalise a price series to zero-mean / unit-std so
  absolute price level / scale do not influence DTW distance.
* :func:`dtw_distance` — Dynamic Time Warping distance between two
  numeric sequences, optionally constrained by a Sakoe-Chiba band so
  cost stays O(n * band) instead of O(n^2).

Both functions are pure: no IO, no global clock / RNG, deterministic
for any fixed input.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence
    from decimal import Decimal


def z_score(series: Sequence[Decimal]) -> list[float]:
    """Return the z-score normalisation of ``series``.

    Args:
        series: Non-empty sequence of ``Decimal`` prices.

    Returns:
        ``[(x - mean) / std]``. If every value is identical (``std == 0``),
        returns an all-zero list — that's what "shape" means for a flat
        line.

    Raises:
        QuantError: ``INVALID_ARGUMENT`` if ``series`` is empty.
    """
    n = len(series)
    if n == 0:
        raise QuantError("INVALID_ARGUMENT", "z_score requires a non-empty series")
    floats = [float(x) for x in series]
    mean = sum(floats) / n
    variance = sum((x - mean) ** 2 for x in floats) / n
    if variance == 0.0:
        return [0.0] * n
    std = math.sqrt(variance)
    return [(x - mean) / std for x in floats]


def dtw_distance(
    a: Sequence[float],
    b: Sequence[float],
    *,
    window: int | None = None,
) -> float:
    """Dynamic Time Warping distance between two real sequences.

    Args:
        a, b: Numeric sequences (typically z-scored close prices).
        window: Sakoe-Chiba band radius. ``None`` removes the constraint.
            ``0`` forces strict alignment (pointwise Euclidean over the
            shorter prefix). Negative values are rejected.

    Returns:
        ``sqrt`` of the accumulated squared-distance along the optimal
        warping path. Identical sequences return ``0.0``.

    Raises:
        QuantError: ``INVALID_ARGUMENT`` for empty inputs or negative
            window.
    """
    if not a or not b:
        raise QuantError("INVALID_ARGUMENT", "dtw_distance requires non-empty sequences")
    if window is not None and window < 0:
        raise QuantError("INVALID_ARGUMENT", f"window must be >= 0, got {window}")

    n, m = len(a), len(b)
    band = max(n, m) if window is None else max(window, abs(n - m))

    inf = math.inf
    # cost[i][j] = best accumulated squared distance for a[:i] vs b[:j]
    prev = [inf] * (m + 1)
    prev[0] = 0.0
    for i in range(1, n + 1):
        curr = [inf] * (m + 1)
        j_lo = max(1, i - band)
        j_hi = min(m, i + band)
        for j in range(j_lo, j_hi + 1):
            d = a[i - 1] - b[j - 1]
            cost = d * d
            best_prev = min(prev[j], prev[j - 1], curr[j - 1])
            curr[j] = cost + best_prev
        prev = curr

    final = prev[m]
    if math.isinf(final):
        # Band too narrow to align a[:n] to b[:m]; treat as caller error.
        raise QuantError(
            "INVALID_ARGUMENT",
            f"DTW band {window} too narrow for lengths {n}/{m}",
        )
    return math.sqrt(final)
