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
