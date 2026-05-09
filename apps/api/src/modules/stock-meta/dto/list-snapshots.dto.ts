import { z } from 'zod';

/**
 * `GET /api/stocks/snapshots?codes=…` — comma-separated codes; an empty
 * string is allowed and means **the full universe** (server expands to
 * every stock-meta code in the cache, mirroring `kline/bulk`). Going
 * through the URL line for ~5 500 codes blows past Express's header
 * budget, so the FE collapses the synthetic "All" sector into this
 * empty-`codes` form and lets the Flight server iterate the cache.
 */
export const ListSnapshotsQuerySchema = z
  .object({
    codes: z
      .string()
      .optional()
      .transform((s) => {
        if (s === undefined) return [] as readonly string[];
        const parts = s
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        return parts;
      }),
  })
  .strict();

export type ListSnapshotsQuery = z.infer<typeof ListSnapshotsQuerySchema>;
