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

// ---------------------------------------------------------------------------
// LedgerAnalysis — hard-core diagnostic shape produced by the LLM.
// Statistical percents (win rate, drawdown, contribution) carry no money
// value and are numeric; `netCashFlow.amount` is monetary so it stays as
// a decimal string (CLAUDE.md §2.8).
// ---------------------------------------------------------------------------

const concentrationLevel = z.enum(['high', 'medium', 'low']);
const cashFlowStatus = z.enum(['inflow', 'outflow', 'none']);

export const MaxDrawdownSchema = z
  .object({
    valuePct: z.number(),
    startDate: isoDate,
    endDate: isoDate,
  })
  .strict();

export const ProfitConcentrationSchema = z
  .object({
    level: concentrationLevel,
    corePeriod: z.string().min(1),
    contributionPct: z.number(),
  })
  .strict();

export const NetCashFlowSchema = z
  .object({
    status: cashFlowStatus,
    amount: decimalString,
  })
  .strict();

export const CoreMetricsSchema = z
  .object({
    winRatePct: z.number(),
    pnlRatio: z.number().nullable(),
    maxDrawdown: MaxDrawdownSchema,
    profitConcentration: ProfitConcentrationSchema,
    netCashFlow: NetCashFlowSchema,
  })
  .strict();

export const DisciplineBreachSchema = z
  .object({
    date: isoDate,
    pnlPct: z.number(),
    analysis: z.string().min(1),
  })
  .strict();

export const BehavioralProfilingSchema = z
  .object({
    patternDependency: z.string().min(1),
    disciplineBreaches: z.array(DisciplineBreachSchema),
    emotionalVolatility: z.string().min(1),
  })
  .strict();

export const MarketPhaseSchema = z
  .object({
    timeframe: z.string().min(1),
    environment: z.string().min(1),
  })
  .strict();

export const SystemicInterventionSchema = z
  .object({
    command: z.string().min(1),
    condition: z.string().min(1),
    action: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

export const LedgerAnalysisSchema = z
  .object({
    coreMetrics: CoreMetricsSchema,
    behavioralProfiling: BehavioralProfilingSchema,
    marketMicrostructure: z.array(MarketPhaseSchema),
    systemicInterventions: z.array(SystemicInterventionSchema),
    generatedAt: isoDateTime,
    windowStart: isoDate,
    windowEnd: isoDate,
    entryCount: z.number().int().nonnegative(),
    /** Provider that produced the result (e.g. `"moonshot"`). */
    provider: z.string(),
  })
  .strict();
export type LedgerAnalysis = z.infer<typeof LedgerAnalysisSchema>;
export type CoreMetrics = z.infer<typeof CoreMetricsSchema>;
export type MaxDrawdown = z.infer<typeof MaxDrawdownSchema>;
export type ProfitConcentration = z.infer<typeof ProfitConcentrationSchema>;
export type NetCashFlow = z.infer<typeof NetCashFlowSchema>;
export type BehavioralProfiling = z.infer<typeof BehavioralProfilingSchema>;
export type DisciplineBreach = z.infer<typeof DisciplineBreachSchema>;
export type MarketPhase = z.infer<typeof MarketPhaseSchema>;
export type SystemicIntervention = z.infer<typeof SystemicInterventionSchema>;
