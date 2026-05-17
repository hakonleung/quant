"""Domain types for DDE 主力 fund-flow snapshots (modules/01-stock-meta.md §5).

A phase row carries the trailing-N-day 主力净流入 (super-large + large
order net inflow) figures for one code. We persist the absolute CNY
amount per window plus the same amount divided by the trailing-N-day
本地 kline 成交额 sum — the ratio is what most screens want, but raw
amount lets downstream rebuild any other denominator without a refetch.

``DDE_WINDOWS`` is the canonical tuple of windows surfaced everywhere
(akshare ``stock_individual_fund_flow_rank`` ``indicator`` parameter,
Arrow column names, NestJS DTO, schema columns). Add a window here, the
codec + Flight op + writer must all be updated in lock-step.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Mapping
    from decimal import Decimal


DDE_WINDOWS: Final[tuple[int, ...]] = (3, 5, 10, 20)
"""Trailing-day windows persisted on ``StockMeta.dde``. Order matters —
also defines column suffix order in ``STOCK_META_SCHEMA``."""


@dataclass(frozen=True, slots=True)
class DdePhase:
    """Persisted DDE phase block on :class:`StockMeta`.

    Every field is ``None`` when its window had no upstream data
    (delisted / brand-new listing / akshare returned ``--``). The
    ``ratio_*`` fields are NestJS-computed against ``data/kline``
    ``amount`` sums; they're ``None`` when the kline window had < N
    bars or summed to zero so a divide-by-zero never reaches the row.
    """

    main_net_inflow_3d: Decimal | None
    main_net_inflow_5d: Decimal | None
    main_net_inflow_10d: Decimal | None
    main_net_inflow_20d: Decimal | None
    main_inflow_ratio_3d: Decimal | None
    main_inflow_ratio_5d: Decimal | None
    main_inflow_ratio_10d: Decimal | None
    main_inflow_ratio_20d: Decimal | None


@dataclass(frozen=True, slots=True)
class StockFundFlowRanks:
    """One stock's main-net-inflow figures across :data:`DDE_WINDOWS`.

    Produced by ``AKShareFundFlowRankSource`` and emitted on the
    ``list_stock_fund_flow_ranks`` Flight op; NestJS joins these
    against local kline-amount sums to derive :class:`DdePhase`.
    """

    code: str
    main_net_inflow_by_window: Mapping[int, Decimal | None]
