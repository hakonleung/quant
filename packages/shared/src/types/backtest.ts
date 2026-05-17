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
  })
  .strict();
export type BacktestObservation = z.infer<typeof BacktestObservationSchema>;

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
  })
  .strict();
export type BacktestEvaluateResponse = z.infer<typeof BacktestEvaluateResponseSchema>;
