"""K-line domain types (modules/02-stock-kline.md §2).

Three frozen dataclasses cover the data lifecycle:

* :class:`RawDailyBar` — what a :class:`KlineSource` returns for one
  trading day (no qfq columns, no MA).
* :class:`AdjFactor` — the per-day forward-adjustment factor used to
  compute qfq prices.
* :class:`DailyBar` — the persisted shape: raw + qfq + ``ma{5,10,20,60}``
  + ``pct_chg_qfq``. This is what business code sees through
  :class:`quant_core.ports.kline_repo.KlineRepo`.

The module-level constant :data:`KLINE_FLOOR_DATE` (Beijing time
2024-09-20) caps the earliest trade_date stored anywhere in the kline
pipeline. Changing it requires a full recompute of every code's history
— gate the change behind an RFC.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from decimal import Decimal


KLINE_FLOOR_DATE: Final[date] = date(2024, 9, 20)
"""Earliest trade_date the kline pipeline will store (Asia/Shanghai)."""


@dataclass(frozen=True, slots=True)
class RawDailyBar:
    """Source-shaped bar before qfq + MA pre-computation."""

    code: str
    trade_date: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    amount: Decimal
    turnover_rate: Decimal


@dataclass(frozen=True, slots=True)
class AdjFactor:
    """Forward-adjustment factor for one (code, trade_date)."""

    code: str
    trade_date: date
    factor: Decimal


@dataclass(frozen=True, slots=True)
class DailyBar:
    """Persisted bar — raw + qfq + MA + pct_chg, all pre-computed."""

    code: str
    trade_date: date
    # raw
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    amount: Decimal
    turnover_rate: Decimal
    # qfq
    open_qfq: Decimal
    high_qfq: Decimal
    low_qfq: Decimal
    close_qfq: Decimal
    # MA on close_qfq; None until the window is full.
    ma5: Decimal | None
    ma10: Decimal | None
    ma20: Decimal | None
    ma60: Decimal | None
    # pct_chg_qfq is None on the first stored bar (no previous close).
    pct_chg_qfq: Decimal | None
    adj_factor: Decimal
