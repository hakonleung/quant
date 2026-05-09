/**
 * TA (technical-analysis, beta) DTOs — shared between NestJS gateway,
 * web BFF, and the terminal package. Mirrors the Python
 * `TaAnalysis` dataclass; prices are decimal-as-string per CLAUDE.md
 * §2.8 (no `number` for monetary values).
 */

import { z } from 'zod';

export const TaLevelSchema = z
  .object({
    /** Decimal-as-string in qfq price coordinates. Same precision as kline. */
    price: z.string().regex(/^-?\d+(\.\d+)?$/u, 'expected decimal-as-string'),
    strength: z.enum(['weak', 'medium', 'strong']),
    reason: z.string(),
  })
  .strict();
export type TaLevel = z.infer<typeof TaLevelSchema>;

export const TaTrendSchema = z
  .object({
    direction: z.enum(['up', 'down', 'sideways']),
    horizonDays: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .strict();
export type TaTrend = z.infer<typeof TaTrendSchema>;

export const TaAnalysisSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u, 'expected 6-digit code'),
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'expected YYYY-MM-DD'),
    barsCount: z.number().int().nonnegative(),
    supportLevels: z.array(TaLevelSchema),
    resistanceLevels: z.array(TaLevelSchema),
    trend: TaTrendSchema,
    patterns: z.array(z.string()),
    caveats: z.array(z.string()),
    /** Provider that produced the result (e.g. `"moonshot"`). May be `""`
     * for cached payloads written before the field was added. */
    provider: z.string(),
    /** ISO-8601 with offset; matches sentiment.cachedAt convention. */
    cachedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type TaAnalysis = z.infer<typeof TaAnalysisSchema>;

/**
 * Per-stock TA card embedded inside the sector aggregate. Slim version of
 * `TaAnalysis` — drops support/resistance level lists and patterns, keeps
 * the fields needed to render a brief table view + drive the LLM summary.
 */
export const TaSectorMemberSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u, 'expected 6-digit code'),
    name: z.string(),
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'expected YYYY-MM-DD'),
    trend: TaTrendSchema,
    keyResistance: z.string().nullable(),
    keySupport: z.string().nullable(),
    headline: z.string(),
  })
  .strict();
export type TaSectorMember = z.infer<typeof TaSectorMemberSchema>;

/**
 * Aggregate TA result for a sector. Per-stock cards are produced by Python
 * fan-out (`analyze_ta_many`), the narrative summary by NestJS LlmService.
 */
export const TaSectorAnalysisSchema = z
  .object({
    codes: z.array(z.string().regex(/^\d{6}$/u)),
    /** Distribution of trend directions across members. */
    trendBreakdown: z
      .object({
        up: z.number().int().nonnegative(),
        down: z.number().int().nonnegative(),
        sideways: z.number().int().nonnegative(),
      })
      .strict(),
    /** Average confidence over members with `direction === overallDirection`. */
    overallDirection: z.enum(['up', 'down', 'sideways']),
    overallConfidence: z.number().min(0).max(1),
    members: z.array(TaSectorMemberSchema),
    /** LLM-rendered narrative for the sector as a whole. */
    summary: z.string(),
    caveats: z.array(z.string()),
    cachedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type TaSectorAnalysis = z.infer<typeof TaSectorAnalysisSchema>;
