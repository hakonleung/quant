"""Watch (W-0) realtime quote domain types.

Pure domain types — no IO, no framework deps. The Flight RPC layer
serialises these to/from Arrow tables; the NestJS side mirrors the
shape via ``packages/shared/src/types/watch.ts`` (Decimal as string).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal

WatchMarket = Literal["a", "hk", "us"]


@dataclass(frozen=True, slots=True)
class SpotQuote:
    """Single-shot realtime quote for a watch task.

    All money fields are :class:`Decimal` to avoid float drift; the wire
    format carries them as strings (CLAUDE.md §2.8). ``ts`` is a
    timezone-aware UTC datetime.
    """

    market: WatchMarket
    code: str
    last: Decimal
    day_high: Decimal
    day_low: Decimal
    prev_close: Decimal
    ts: datetime


@dataclass(frozen=True, slots=True)
class StockBasic:
    """Lean universe row — only the fields the Watch UI needs to pick a code."""

    market: WatchMarket
    code: str
    name: str
