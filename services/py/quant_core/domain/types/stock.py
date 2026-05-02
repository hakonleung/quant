"""Stock metadata domain type (modules/01-stock-meta.md §2).

Pure domain object: frozen, slots, no IO. The TS-side zod schema is
generated from ``proto/`` (M3+); Python is the source of truth here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from datetime import date, datetime
    from decimal import Decimal

Exchange = Literal["SH", "SZ", "BJ"]
Board = Literal["MAIN", "CHINEXT", "STAR", "BSE"]
StockStatus = Literal["NORMAL", "ST", "STAR_ST", "SUSPENDED", "DELISTED"]


@dataclass(frozen=True, slots=True)
class StockMeta:
    """A single tradable stock's metadata snapshot."""

    code: str
    name: str
    name_pinyin: str
    exchange: Exchange
    board: Board
    industry_sw_l1: str
    industry_sw_l2: str
    industry_sw_l3: str
    list_date: date
    delist_date: date | None
    total_share: Decimal
    float_share: Decimal
    status: StockStatus
    updated_at: datetime
