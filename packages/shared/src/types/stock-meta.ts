/**
 * Cross-process DTO for stock metadata. Mirrors the Python
 * {@link services/py/quant_core/domain/types/stock.py} `StockMeta`
 * dataclass — both ends are validated against the same shape.
 *
 * Serialization choices (must match the Python side):
 * - `code` is the bare 6-digit string (e.g. `"600519"`). The exchange is
 *   not stored on the row; consumers that need it derive it from the
 *   prefix at the call site.
 * - Dates → ISO `YYYY-MM-DD` strings.
 * - Datetimes → ISO 8601 with explicit UTC offset.
 * - `industries` → comma-joined string from coarse → fine, e.g.
 *   `"食品饮料,白酒"`. Empty string allowed.
 * - `float_pct` → decimal string in `[0, 1]` (e.g. `"1"`, `"0.85"`).
 *   Defaults to `"1"` (fully tradable) for sources that don't expose it.
 *
 * M3+ enrichment fields (`total_share`, `quarterlies`, ...) are nullable
 * / empty until the akshare financial scrapers populate them; downstream
 * derive functions return `null` for any metric whose inputs are
 * missing.
 */

import { z } from 'zod';

const sixDigitCode = z.string().regex(/^\d{6}$/, 'expected 6-digit numeric code');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const isoDateTime = z.string().datetime({ offset: true });
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected decimal as string');
const decimalStringOrNull = decimalString.nullable();

/**
 * One reporting-period snapshot of a stock's income-statement line items.
 * Stored alongside the meta as a tuple of up to 8, ordered oldest → newest.
 * Any field can be null when the source didn't expose it (e.g. `stock_yjbb_em`
 * never returns 扣非 / 营业成本).
 */
export const QuarterlyFinancialsSchema = z
  .object({
    period: isoDate,
    revenue: decimalStringOrNull,
    operating_cost: decimalStringOrNull,
    net_profit: decimalStringOrNull,
    net_profit_excl_nr: decimalStringOrNull,
  })
  .strict();

export type QuarterlyFinancials = z.infer<typeof QuarterlyFinancialsSchema>;

export const StockMetaDtoSchema = z
  .object({
    code: sixDigitCode,
    name: z.string(),
    name_pinyin: z.string(),
    industries: z.string(),
    list_date: isoDate,
    float_pct: decimalString,
    updated_at: isoDateTime,
    // M3 — financial-enrichment fields. Nullable / empty for legacy rows.
    total_share: decimalStringOrNull,
    float_share: decimalStringOrNull,
    net_assets: decimalStringOrNull,
    net_assets_period: isoDate.nullable(),
    quarterlies: z.array(QuarterlyFinancialsSchema).max(8),
    financials_updated_at: isoDateTime.nullable(),
  })
  .strict();

export type StockMetaDto = z.infer<typeof StockMetaDtoSchema>;

/**
 * DDE 主力 fund-flow phase block. Mirrors the Python
 * `quant_core.domain.types.fund_flow.DdePhase` dataclass; populated by
 * `StockFundFlowSyncService` once per batch settle.
 *
 * - `main_net_inflow_<N>d` — trailing-N-day 主力(超大单+大单) net
 *   inflow in CNY (decimal string, may be negative). `null` when the
 *   akshare rank endpoint had no data for that window.
 * - `main_inflow_ratio_<N>d` — `main_net_inflow_<N>d` divided by the
 *   trailing-N-day local-kline `amount` sum. `null` when the kline
 *   window had < N bars or summed to zero.
 *
 * All windows are emitted together; a partial block (e.g. ratio set
 * but inflow null) is allowed and means "we have an inflow value but
 * the local kline can't back it" — consumers should treat any null
 * as "unknown" rather than zero.
 */
export const DdePhaseDtoSchema = z
  .object({
    main_net_inflow_3d: decimalStringOrNull,
    main_net_inflow_5d: decimalStringOrNull,
    main_net_inflow_10d: decimalStringOrNull,
    main_net_inflow_20d: decimalStringOrNull,
    main_inflow_ratio_3d: decimalStringOrNull,
    main_inflow_ratio_5d: decimalStringOrNull,
    main_inflow_ratio_10d: decimalStringOrNull,
    main_inflow_ratio_20d: decimalStringOrNull,
  })
  .strict();

export type DdePhaseDto = z.infer<typeof DdePhaseDtoSchema>;

/**
 * Canonical trailing-day windows the DDE pipeline persists. Used by
 * NestJS sync / writer and surfaced to the FE for label rendering.
 * Edit here + the Python `DDE_WINDOWS` constant in lock-step.
 */
export const DDE_WINDOWS = [3, 5, 10, 20] as const;
export type DdeWindow = (typeof DDE_WINDOWS)[number];

/**
 * Server-side derived list-view payload. `meta` is the structural
 * snapshot; `derived` is computed at request time from `meta` + latest
 * `close_qfq`. The DTO is read-only (UI list rendering) and never written
 * back to parquet.
 *
 * Each derived metric is `null` when any input is missing or any
 * denominator is ≤ 0 — UI renders `—` for nulls; sort treats them as
 * the smallest value.
 */
export const StockDerivedMetricsSchema = z
  .object({
    mkt_cap: decimalStringOrNull,
    float_mkt_cap: decimalStringOrNull,
    pe_ttm: decimalStringOrNull,
    pe_dynamic: decimalStringOrNull,
    pb: decimalStringOrNull,
    peg: decimalStringOrNull,
    gross_margin_ttm: decimalStringOrNull,
    /**
     * Wave-quality composite ∈ [0, 1000]. `null` when bars < 30 or the
     * net-down survivor gate fails. See `docs/perf/wcmi-redesign.md`.
     */
    wcmi: decimalStringOrNull,
    /** Per-dimension cross-sectional percentile × 100. `null` when `wcmi` is null. */
    wcmi_rhythm: decimalStringOrNull,
    wcmi_ma_support: decimalStringOrNull,
    wcmi_up_wave: decimalStringOrNull,
    wcmi_yang_dom: decimalStringOrNull,
    wcmi_shadow_clean: decimalStringOrNull,
    wcmi_stage_gain: decimalStringOrNull,
    wcmi_crash_avoid: decimalStringOrNull,
  })
  .strict();

export type StockDerivedMetrics = z.infer<typeof StockDerivedMetricsSchema>;

/**
 * Period-return windows surfaced by EQ.LIST. Values are decimal strings
 * representing the fractional change against `close_qfq` N trading bars
 * ago (e.g. `"0.0532"` for +5.32 %). `null` when the kline history is
 * shorter than the requested window.
 */
export const StockReturnsSchema = z
  .object({
    ret_1d: decimalStringOrNull,
    ret_5d: decimalStringOrNull,
    ret_10d: decimalStringOrNull,
    ret_20d: decimalStringOrNull,
    ret_90d: decimalStringOrNull,
    ret_250d: decimalStringOrNull,
  })
  .strict();

export type StockReturns = z.infer<typeof StockReturnsSchema>;

export const StockSnapshotDtoSchema = z
  .object({
    meta: StockMetaDtoSchema,
    price: decimalStringOrNull,
    asof: isoDate.nullable(),
    derived: StockDerivedMetricsSchema,
    returns: StockReturnsSchema,
    // DDE 主力 fund-flow phase block; `null` for codes the akshare
    // rank endpoint never surfaced (delisted / brand-new listing).
    dde: DdePhaseDtoSchema.nullable(),
  })
  .strict();

export type StockSnapshotDto = z.infer<typeof StockSnapshotDtoSchema>;
