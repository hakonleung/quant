/**
 * Cross-process schema for the Feat 105 pattern-match flow.
 * Mirrors `services/py/quant_core/domain/types/pattern.py`. The Flight
 * op `find_similar_patterns` returns one row per match in the JSON
 * payload tunnel; the NestJS controller maps it onto these schemas.
 */

import { z } from 'zod';

export const PatternFindSimilarRequestSchema = z
  .object({
    code: z.string().min(1),
    /** YYYY-MM-DD inclusive. */
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** YYYY-MM-DD inclusive. */
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    topN: z.number().int().positive().max(200).default(20),
  })
  .strict();
export type PatternFindSimilarRequest = z.infer<typeof PatternFindSimilarRequestSchema>;

export const PatternMatchSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Combined similarity — DTW shape distance + period-return penalty. Smaller = closer. */
    similarity: z.number(),
    /** Cumulative return of the matched window (fraction; 0.12 = +12%). */
    periodReturn: z.number(),
  })
  .strict();
export type PatternMatch = z.infer<typeof PatternMatchSchema>;

export const PatternFindSimilarResponseSchema = z
  .object({
    referenceCode: z.string(),
    referenceStart: z.string(),
    referenceEnd: z.string(),
    windowDays: z.number().int().positive(),
    /** Reference's cumulative return (fraction). */
    referencePeriodReturn: z.number(),
    matches: z.array(PatternMatchSchema),
  })
  .strict();
export type PatternFindSimilarResponse = z.infer<typeof PatternFindSimilarResponseSchema>;
