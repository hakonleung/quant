"""Technical-analysis domain types (beta).

The ``ta`` feature is a price/volume-only AI pass that takes 90 daily
bars (qfq prices + pre-computed MAs) and asks Kimi Pro to identify
support / resistance levels and predict the near-term trend. No news,
no web search.

This is a deliberately narrow domain (one read method, one write method)
so the dataclass tree stays flat: a payload is one ``TaAnalysis`` with
two flat lists of ``TaLevel`` plus a single ``TaTrend`` and string lists
for patterns / caveats.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

if TYPE_CHECKING:
    from datetime import date, datetime
    from decimal import Decimal


SCHEMA_VERSION: Final[int] = 1
"""Bumped when ``TaAnalysis`` shape changes in a non-additive way."""


TaLevelStrength = Literal["weak", "medium", "strong"]
"""How confident the analyst is that the level will hold."""

TaTrendDirection = Literal["up", "down", "sideways"]
"""Near-term trend bias."""


@dataclass(frozen=True, slots=True)
class TaLevel:
    """One support or resistance level."""

    price: Decimal
    """Quoted in qfq terms — same coordinate system as the input bars."""
    strength: TaLevelStrength
    """Subjective confidence the level will hold under retest."""
    reason: str
    """Free-text justification (cluster of touches, MA confluence, etc.)."""


@dataclass(frozen=True, slots=True)
class TaTrend:
    """Forward-looking call on price direction over a finite horizon."""

    direction: TaTrendDirection
    horizon_days: int
    """Forecast window length in trading days. Positive."""
    confidence: float
    """``[0, 1]``; higher = stronger conviction."""
    rationale: str


@dataclass(frozen=True, slots=True)
class TaAnalysis:
    """One stock's structured 90D technical analysis output."""

    code: str
    """Bare 6-digit A-share code."""
    asof: date
    """The reference trading day the LLM analysed (last bar's date)."""
    bars_count: int
    """How many daily bars were fed to the LLM. Should be ≤ 90."""
    support_levels: tuple[TaLevel, ...]
    """Lower-bound levels, ordered nearest → farthest below current price."""
    resistance_levels: tuple[TaLevel, ...]
    """Upper-bound levels, ordered nearest → farthest above current price."""
    trend: TaTrend
    patterns: tuple[str, ...]
    """Named price patterns observed (head-and-shoulders, flag, etc.)."""
    caveats: tuple[str, ...]
    """Quality warnings — low volume, suspended bars, etc."""
    fetched_at: datetime
    """UTC timestamp the LLM call returned."""
    schema_version: int = SCHEMA_VERSION
    provider: str = ""
    """Which LLM produced the result (``"moonshot"``, ``"qwen"``, ...).
    Empty when read from a payload that predates the field — adapters
    must default-fill rather than fail."""
