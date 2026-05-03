"""Pattern-matching domain types (modules/04-pattern-matching.md §2).

Frozen dataclasses describing the inputs / outputs of the DTW-based
pattern matcher. Lives in ``domain/types`` so any layer can import without
pulling adapters or compute deps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date
    from decimal import Decimal


PatternSourceKind = Literal["from_stock", "hand_drawn", "uploaded"]


@dataclass(frozen=True, slots=True)
class PatternSourceFromStock:
    """Reference series extracted from a real stock window."""

    kind: Literal["from_stock"]
    code: str
    start_date: date
    end_date: date


@dataclass(frozen=True, slots=True)
class PatternSourceHandDrawn:
    """Reference series drawn by the user (v2)."""

    kind: Literal["hand_drawn"]


@dataclass(frozen=True, slots=True)
class PatternSourceUploaded:
    """Reference series uploaded as CSV."""

    kind: Literal["uploaded"]
    filename: str


PatternSource = PatternSourceFromStock | PatternSourceHandDrawn | PatternSourceUploaded


@dataclass(frozen=True, slots=True)
class PatternSeries:
    """Reference K-line shape — qfq close prices.

    OHLC-aware comparison is a v2 feature; v1 only consumes ``closes``.
    """

    closes: Sequence[Decimal]
    source: PatternSource


@dataclass(frozen=True, slots=True)
class PatternQuery:
    """Inputs to a pattern-matching scan."""

    reference: PatternSeries
    universe: Sequence[str]
    window_days: int
    asof_end: date
    lookback_days: int
    top_n: int = 50


@dataclass(frozen=True, slots=True)
class PatternMatch:
    """One (code, window) hit, ordered by ascending DTW distance."""

    code: str
    start_date: date
    end_date: date
    distance: float
    aligned_path: tuple[tuple[int, int], ...] | None = None
