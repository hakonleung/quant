/**
 * Cross-process Ledger DTO. The user records daily P/L manually:
 *
 *   { date, pnlAmount, closingPosition? }
 *
 * `closingPosition` is mandatory on the **earliest** entry (anchor of the
 * derived chain) and optional everywhere else. Missing closings are
 * filled in at read time by the pure-function layer
 * (`enrichEntries` in `@quant/shared/fp`) so the on-disk JSON stays
 * minimal and reflects exactly what the user typed.
 *
 * Decimals (`pnlAmount`, `closingPosition`) are stringified to avoid
 * `number` precision loss — see CLAUDE.md §2.8 (no `number` for monetary
 * values).
 */

import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'expected YYYY-MM-DD');
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/u, 'expected decimal-as-string');
const isoDateTime = z.string().datetime({ offset: true });

export const LedgerEntrySchema = z
  .object({
    date: isoDate,
    pnlAmount: decimalString,
    /**
     * End-of-day position size after the day's PnL settles. Required on
     * the earliest entry — the derived chain's anchor. May be `null` /
     * omitted on later entries; in that case the runtime fills it in via
     * `closingPosition_{i-1} + pnlAmount_i`.
     */
    closingPosition: decimalString.nullable().optional(),
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerSnapshotSchema = z
  .object({
    /** Sorted ascending by date, with no duplicate dates. */
    entries: z.array(LedgerEntrySchema),
  })
  .strict();
export type LedgerSnapshot = z.infer<typeof LedgerSnapshotSchema>;

export const EMPTY_LEDGER: LedgerSnapshot = { entries: [] };

/**
 * In-memory enriched view of a snapshot — every entry has its closing
 * position resolved, the day's pct derived, and the implicit cash flow
 * surfaced (`Δclosing − pnlAmount`, non-zero when the user deposits /
 * withdraws / receives dividends).
 */
export const EnrichedLedgerEntrySchema = LedgerEntrySchema.extend({
  /** Resolved closing position (user-provided OR chain-derived). */
  derivedClosingPosition: decimalString,
  /** True iff the user typed `closingPosition`; false when chain-filled. */
  closingProvided: z.boolean(),
  /** Day's PnL as percentage of prior closing position. `"0"` for the synthetic anchor day. */
  derivedDailyPct: decimalString,
  /** Implicit cash flow: `derivedClosing − prevDerivedClosing − pnlAmount`. */
  cashFlow: decimalString,
}).strict();
export type EnrichedLedgerEntry = z.infer<typeof EnrichedLedgerEntrySchema>;

export const LedgerAnalysisSchema = z
  .object({
    summary: z.string(),
    operationStyle: z.string(),
    marketView: z.string(),
    recommendations: z.array(z.string()),
    generatedAt: isoDateTime,
    windowStart: isoDate,
    windowEnd: isoDate,
    entryCount: z.number().int().nonnegative(),
    /** Provider that produced the result (e.g. `"moonshot"`). */
    provider: z.string(),
  })
  .strict();
export type LedgerAnalysis = z.infer<typeof LedgerAnalysisSchema>;
