/**
 * Request DTOs for the TA controller. Response DTO is the shared
 * `TaAnalysisSchema` from `@quant/shared`.
 */

import { z } from 'zod';

const codeRule = z.string().regex(/^\d{6}$/u, 'expected 6-digit code');

export const AnalyzeTaOneQuerySchema = z.object({ code: codeRule }).strict();
export type AnalyzeTaOneQuery = z.infer<typeof AnalyzeTaOneQuerySchema>;

export const AnalyzeTaOneBodySchema = z
  .object({
    code: codeRule,
    bypassCache: z.boolean().optional(),
  })
  .strict();
export type AnalyzeTaOneBody = z.infer<typeof AnalyzeTaOneBodySchema>;
