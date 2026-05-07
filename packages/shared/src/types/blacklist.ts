/**
 * Cross-process Blacklist DTO.
 *
 * The blacklist is computed daily by the backend cron from cached kline
 * (see `services/py/quant_core/services/blacklist_service.py`) and
 * persisted as `data/blacklist.json` on the NestJS side. The frontend
 * reads it via `GET /api/blacklist` to filter the synthetic
 * `sector all` view (see `docs/modules/12-blacklist.md`).
 */

import { z } from 'zod';

export const BlacklistSnapshotSchema = z.object({
  /** Sorted A-share codes that failed every stage-return threshold. */
  codes: z.array(z.string()).readonly(),
  /** ISO date the cron used as the cutoff for the stage returns. */
  asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'expected YYYY-MM-DD'),
  /** Total A-share universe size considered (drift sanity-check). */
  universeSize: z.number().int().nonnegative(),
  /** ISO datetime the result was persisted to disk. */
  computedAt: z.string().datetime({ offset: true }),
});
export type BlacklistSnapshot = z.infer<typeof BlacklistSnapshotSchema>;

export const EMPTY_BLACKLIST: BlacklistSnapshot = {
  codes: [],
  asof: '1970-01-01',
  universeSize: 0,
  computedAt: '1970-01-01T00:00:00.000Z',
};
