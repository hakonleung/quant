/**
 * Cross-process schema for the screen-signal backtest flow.
 * Mirrors `services/py/quant_core/domain/types/signal_eval.py`.
 *
 * Two request shapes (one endpoint each):
 *   - `evaluate-signals` — caller already has the (date, code) signal
 *     stream and only wants the distribution stats.
 *   - `evaluate-screen` — caller passes a screen AST + date window;
 *     NestJS iterates trading days, runs the screen for each, then
 *     forwards the resulting signals to the Python op. Useful when a
 *     UI just wants "give me the distribution for this DSL".
 *
 * Both endpoints return the same payload (`BacktestEvaluateResponse`).
 */

import { z } from 'zod';

import {
  ScreenPlanAstSchema,
  UniversePlanAstSchema,
  RankSpecSchema,
} from './nl-screen.js';

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const HoldingsSchema = z
  .array(z.number().int().positive().max(500))
  .min(1)
  .max(32)
  .refine((v) => new Set(v).size === v.length, {
    message: 'holdings must be unique',
  });

export const BacktestSignalSchema = z
  .object({
    signalDate: DateStringSchema,
    code: z.string().regex(/^\d{6}$/, 'expected 6-digit code'),
  })
  .strict();
export type BacktestSignal = z.infer<typeof BacktestSignalSchema>;

/** Primitive: caller-supplied signals. */
export const BacktestEvaluateSignalsRequestSchema = z
  .object({
    signals: z.array(BacktestSignalSchema).min(1).max(200_000),
    holdings: HoldingsSchema,
  })
  .strict();
export type BacktestEvaluateSignalsRequest = z.infer<typeof BacktestEvaluateSignalsRequestSchema>;

/** Orchestration: run a screen daily across a window. */
export const BacktestEvaluateScreenRequestSchema = z
  .object({
    screenPlan: ScreenPlanAstSchema,
    universePlan: UniversePlanAstSchema.nullable().optional(),
    rank: RankSpecSchema.nullable().optional(),
    /** Inclusive YYYY-MM-DD. Signals are emitted for trading days in [start, end]. */
    startDate: DateStringSchema,
    endDate: DateStringSchema,
    holdings: HoldingsSchema,
  })
  .strict();
export type BacktestEvaluateScreenRequest = z.infer<typeof BacktestEvaluateScreenRequestSchema>;

export const BacktestObservationSchema = z
  .object({
    signalDate: DateStringSchema,
    code: z.string(),
    holding: z.number().int().positive(),
    entryDate: DateStringSchema,
    entryPx: z.number(),
    exitDate: DateStringSchema,
    exitPx: z.number(),
    /** Return between entry and exit open as a fraction (0.12 = +12%). */
    ret: z.number(),
    /**
     * Universe-wide mean return at the same (signalDate, holding) — null
     * when no baseline was supplied by the gateway. The "expected return"
     * of a random pick on that day, so `ret - baselineMean = alpha`.
     */
    baselineMean: z.number().nullable(),
    /** ret - baselineMean; null when baselineMean is null. */
    excessRet: z.number().nullable(),
  })
  .strict();
export type BacktestObservation = z.infer<typeof BacktestObservationSchema>;

/**
 * Universe-baseline aggregate (computed by NestJS via DuckDB over the
 * full kline parquet and shipped to Python). For each `holding`, the
 * mean and std of the **per-date universe mean return** — i.e. "the
 * average return you'd get by buying every code on every day in the
 * window and holding it for N days".
 *
 * Why std-of-means (not std-of-individual-returns): the spread t-stat
 * below is computed against this baseline series, so we need its
 * dispersion at the same granularity (one number per signal date).
 */
export const BacktestBaselineSummarySchema = z
  .object({
    holding: z.number().int().positive(),
    /** Number of trading dates contributing to the baseline series. */
    n: z.number().int().nonnegative(),
    universeMean: z.number(),
    universeStd: z.number(),
  })
  .strict();
export type BacktestBaselineSummary = z.infer<typeof BacktestBaselineSummarySchema>;

/**
 * "Selection effect" t-stat per holding. For each signal date with at
 * least one observation at this holding, compute the spread
 * `mean(signal_returns) - universe_mean(date, holding)`. Then aggregate
 * over dates: mean / std / t-stat / win-rate.
 *
 * Reading the t-stat: |t| > 2 → the screen's selection on top of the
 * universe baseline is statistically significant on this window.
 */
export const BacktestSpreadSummarySchema = z
  .object({
    holding: z.number().int().positive(),
    /** Number of distinct signal dates contributing to the spread series. */
    n: z.number().int().nonnegative(),
    spreadMean: z.number(),
    spreadStd: z.number(),
    /** `spreadMean / (spreadStd / sqrt(n))`; 0 when n < 2 or std == 0. */
    spreadTStat: z.number(),
    /** Fraction of dates where the signal beat the universe. */
    winRate: z.number(),
  })
  .strict();
export type BacktestSpreadSummary = z.infer<typeof BacktestSpreadSummarySchema>;

export const BacktestHoldingSummarySchema = z
  .object({
    holding: z.number().int().positive(),
    n: z.number().int().nonnegative(),
    mean: z.number(),
    median: z.number(),
    std: z.number(),
    p05: z.number(),
    p25: z.number(),
    p75: z.number(),
    p95: z.number(),
    winRate: z.number(),
    sharpeLike: z.number(),
  })
  .strict();
export type BacktestHoldingSummary = z.infer<typeof BacktestHoldingSummarySchema>;

export const BacktestEvaluateResponseSchema = z
  .object({
    holdings: z.array(z.number().int().positive()),
    /** [first signalDate, last signalDate] or null if no signals. */
    signalDateRange: z.tuple([DateStringSchema, DateStringSchema]).nullable(),
    /** Average signals per signal day in the input. */
    universeSizeAvg: z.number(),
    observations: z.array(BacktestObservationSchema),
    summary: z.array(BacktestHoldingSummarySchema),
    /** Present only when the gateway shipped a baseline series. */
    baselineSummary: z.array(BacktestBaselineSummarySchema).nullable(),
    /** Present only when baselineSummary is present (depends on it). */
    spreadSummary: z.array(BacktestSpreadSummarySchema).nullable(),
  })
  .strict();
export type BacktestEvaluateResponse = z.infer<typeof BacktestEvaluateResponseSchema>;
