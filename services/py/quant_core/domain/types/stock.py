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
    - ``float_pct`` (``float_share / total_share``) is a derived ratio kept
      on the row for backwards compat with the screening evaluator. M3+
      adds the structural counts (``total_share``, ``float_share``) so the
      ratio can be re-computed when share-restructuring data lands.
    - **M3 enrichment** adds quarterly financials and balance-sheet
      structurals so price-derived metrics (PE/PB/PEG/市值/毛利率) can be
      computed at request time without persisting derivative ratios that
      would drift with every price tick. See
      ``quant_core.domain.pure.derive_metrics`` for the formulas.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from quant_core.domain.types.fund_flow import DdePhase

if TYPE_CHECKING:
    from datetime import date, datetime
    from decimal import Decimal


@dataclass(frozen=True, slots=True)
class QuarterlyFinancials:
    """One reporting-period snapshot of a stock's income-statement line items.

    Stored alongside :class:`StockMeta` as a tuple of up to 8, ordered
    oldest → newest. Any field is ``None`` when the source didn't expose
    it — for example ``stock_yjbb_em`` returns net_profit + revenue but
    never 扣非 / 营业成本; those land later from the per-stock
    ``stock_financial_abstract_ths`` enricher.

    Encoded into Parquet as a single JSON-string column (see
    ``quant_cache.stock_meta_schema``); the Python codec round-trips
    through this dataclass to keep the schema flat across arrow bindings.
    """

    period: date
    """Reporting period — quarter-end date, e.g. ``date(2025, 9, 30)``."""
    revenue: Decimal | None
    """Operating revenue (营业总收入) in CNY."""
    operating_cost: Decimal | None
    """Operating cost (营业成本) in CNY. Required for gross-margin TTM."""
    net_profit: Decimal | None
    """Net profit attributable to shareholders (归母净利润) in CNY."""
    net_profit_excl_nr: Decimal | None
    """Net profit excluding non-recurring items (扣非归母净利润) in CNY."""


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
    # ---- M3 financial enrichment (default ``None`` / empty for legacy rows).
    total_share: Decimal | None = None
    """Total share count (总股本) in shares. ``None`` until enriched."""
    float_share: Decimal | None = None
    """Free-float share count (流通股本) in shares. ``None`` until enriched."""
    net_assets: Decimal | None = None
    """Latest period 归母净资产 (CNY). Used for the PB derived metric."""
    net_assets_period: date | None = None
    """Reporting period the ``net_assets`` snapshot belongs to."""
    quarterlies: tuple[QuarterlyFinancials, ...] = field(default_factory=tuple)
    """Up to 8 quarters of financials, ordered oldest → newest."""
    financials_updated_at: datetime | None = None
    """Last time the financials track populated this row (UTC)."""
    # ---- Persisted snapshot projection. Populated by
    # ``upsert_stock_metrics_for_code`` after every kline sync; ``None``
    # on a freshly-listed stock with no bars yet.
    metrics: PersistedMetrics | None = None
    """Latest projected returns + derived-metric block, or ``None``."""
    metrics_updated_at: datetime | None = None
    """When :attr:`metrics` was last refreshed (UTC)."""
    # ---- DDE 主力 fund-flow phase block. Populated by
    # ``StockFundFlowSyncService`` (NestJS) once per batch settle; ``None``
    # for codes the akshare rank endpoint never surfaced (delisted /
    # brand-new listing).
    dde: DdePhase | None = None
    """Trailing-N-day 主力净流入 amount + amount/turnover ratio block."""
    dde_updated_at: datetime | None = None
    """When :attr:`dde` was last refreshed (UTC)."""


@dataclass(frozen=True, slots=True)
class PersistedMetrics:
    """Pre-computed list-view metrics persisted alongside the row.

    Mirrors the NestJS projector ``StockMetricsComputeService`` output
    (apps/api/src/modules/stock-meta/stock-metrics-compute.service.ts)
    sans the ``code`` field (encoded by the parent ``StockMeta``).
    Every numeric field is ``None`` when its input was missing or its
    denominator was non-positive — same nullability rules as the
    snapshot handler's on-demand path.
    """

    asof: date | None
    """Latest kline trade_date the metrics were computed against."""
    price: Decimal | None
    """``close_qfq`` at ``asof`` — persisted so the snapshot row can be
    served without a second kline read."""
    ret_1d: Decimal | None
    ret_5d: Decimal | None
    ret_10d: Decimal | None
    ret_20d: Decimal | None
    ret_90d: Decimal | None
    ret_250d: Decimal | None
    mkt_cap: Decimal | None
    float_mkt_cap: Decimal | None
    pe_ttm: Decimal | None
    pe_dynamic: Decimal | None
    pb: Decimal | None
    peg: Decimal | None
    gross_margin_ttm: Decimal | None
