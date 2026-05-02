import { z } from 'zod';

const MAX_BATCH = 500;

/**
 * `GET /api/stocks/batch?codes=600519.SH,000858.SZ` — comma-separated to
 * keep the URL trivially shareable. Server splits + de-duplicates.
 */
export const GetBatchQuerySchema = z
  .object({
    codes: z
      .string()
      .min(1, 'codes is required')
      .transform((s, ctx) => {
        const parts = s
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        if (parts.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'codes must not be empty' });
          return z.NEVER;
        }
        if (parts.length > MAX_BATCH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `codes batch may not exceed ${String(MAX_BATCH)} items`,
          });
          return z.NEVER;
        }
        return parts;
      }),
  })
  .strict();

export type GetBatchQuery = z.infer<typeof GetBatchQuerySchema>;
