/**
 * Query DTO for ``GET /api/kline/:code``. The frontend ranging
 * convention (``30D`` / ``90D`` / ``250D``) is decoded here into the
 * row-count the Python op expects.
 */

import { z } from 'zod';

export const KlineRangeQuerySchema = z
  .object({
    range: z.enum(['30D', '90D', '250D']).default('90D'),
  })
  .strict();

export type KlineRangeQuery = z.infer<typeof KlineRangeQuerySchema>;

/** Mapping from human range to "last N trading bars". */
export const RANGE_TO_N: Readonly<Record<KlineRangeQuery['range'], number>> = {
  '30D': 30,
  '90D': 90,
  '250D': 250,
};
