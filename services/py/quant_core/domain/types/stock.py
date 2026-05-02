"""Stock metadata domain type (modules/01-stock-meta.md §2).

Pure domain object: frozen, slots, no IO. The TS-side zod schema is
generated from ``proto/`` (M3+); Python is the source of truth here.

Schema notes (post-refactor):
    - ``code`` is the bare 6-digit string identifier (e.g. ``"600519"``);
      the exchange is **not** stored on the row. A-share code spaces do
      not overlap across SH/SZ/BJ, so the bare form is a unique key. When
      a downstream consumer needs the exchange (e.g. XQ symbol building)
      it derives it from the code prefix at the call site.
    - ``industries`` is a single comma-separated string (e.g.
      ``"白酒,食品饮料"``) instead of three Shenwan-tier columns. Some
      sources only expose one industry and others several; flattening
      avoids null-handling at every consumer.
    - ``board``, ``delist_date``, ``status`` are intentionally **absent**.
      Board can be re-derived from the code prefix when a UI needs it;
      the cache only stores currently-listed stocks (``list_status="L"``
      at the source level), so a delisting drops the row at the next sync
      rather than flipping a flag.
    - ``float_pct`` (``float_share / total_share``) replaces the raw share
      counts: it's the only ratio business code actually uses, and it
      survives stock splits without an adj_factor column.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from datetime import date, datetime
    from decimal import Decimal


@dataclass(frozen=True, slots=True)
class StockMeta:
    """A single tradable stock's metadata snapshot."""

    code: str
    """Bare 6-digit string identifier, e.g. ``"600519"``."""
    name: str
    """Display name in the source language (Chinese for A-share)."""
    name_pinyin: str
    """Pinyin initials (UPPER_SNAKE) — e.g. ``"GZMT"`` for ``贵州茅台``."""
    industries: str
    """Comma-separated industry tags from coarse → fine, e.g. ``"食品饮料,白酒"``."""
    list_date: date
    float_pct: Decimal
    """Tradable-float share of total equity, in [0, 1]. ``1`` means the
    full equity is freely tradable; less means part is restricted /
    locked. Encoded as :class:`Decimal` to round-trip through Parquet
    string storage without float drift. Default is ``Decimal(1)`` for
    sources that don't expose it (e.g. AKShare bulk listing)."""
    updated_at: datetime
    """When this snapshot was written into the local cache (UTC)."""
