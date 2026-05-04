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
  })
  .strict();

export type StockDerivedMetrics = z.infer<typeof StockDerivedMetricsSchema>;

export const StockSnapshotDtoSchema = z
  .object({
    meta: StockMetaDtoSchema,
    price: decimalStringOrNull,
    asof: isoDate.nullable(),
    derived: StockDerivedMetricsSchema,
  })
  .strict();

export type StockSnapshotDto = z.infer<typeof StockSnapshotDtoSchema>;
