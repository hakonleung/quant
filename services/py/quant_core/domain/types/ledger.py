"""Personal ledger domain types.

The user records daily P/L manually; AI analysis runs on the last ≤ 30
days. Schema mirrors the TS side (`packages/shared/src/types/ledger.ts`)
but uses Python conventions: snake_case field names, `Decimal` for
money, frozen dataclasses for immutability.

Persistence happens entirely on the NestJS side (small JSON file). The
Python service only sees enriched entries via the Flight RPC envelope —
this module exists so the prompt-builder + LLM-decoder have proper
typed inputs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from datetime import date, datetime
    from decimal import Decimal


SCHEMA_VERSION: Final[int] = 1
"""Bumped when ``LedgerAnalysis`` shape changes in a non-additive way."""


@dataclass(frozen=True, slots=True)
class EnrichedLedgerEntry:
    """One enriched ledger entry, as it crosses the Flight boundary.

    ``closing_position`` is always populated (NestJS resolves it from the
    chain before sending) and ``closing_provided`` records whether the
    user typed it explicitly. ``cash_flow`` surfaces implicit deposits /
    withdrawals — non-zero when ``Δclosing − pnl_amount ≠ 0``.
    """

    date: date
    pnl_amount: Decimal
    closing_position: Decimal
    closing_provided: bool
    cash_flow: Decimal
    derived_daily_pct: Decimal


@dataclass(frozen=True, slots=True)
class LedgerAnalysis:
    """Structured AI analysis output.

    Fields mirror ``LedgerAnalysisSchema`` on the TS side; the controller
    JSON-encodes this dataclass and the gateway parses it back via the
    same zod schema, so the two are validated end-to-end.
    """

    summary: str
    operation_style: str
    market_view: str
    recommendations: tuple[str, ...]
    generated_at: datetime
    window_start: date
    window_end: date
    entry_count: int
    provider: str = ""
