/**
 * Zod schemas for the Watch HTTP surface (`docs/modules/W-0-watch.md` §10).
 *
 * The body schemas are re-exports from `@quant/shared` (cross-process
 * single source of truth) plus a few request-only shapes for path /
 * query params.
 */

import { z } from 'zod';
import {
  WatchGroupCreateSchema,
  WatchGroupNameSchema,
  WatchMarketSchema,
  WatchTaskCreateSchema,
  WatchTaskPatchSchema,
} from '@quant/shared';

export { WatchGroupCreateSchema, WatchTaskCreateSchema, WatchTaskPatchSchema };
export type { WatchGroupCreate, WatchTaskCreate, WatchTaskPatch } from '@quant/shared';

export const WatchTaskParamsSchema = z
  .object({
    market: WatchMarketSchema,
    code: z.string().min(1),
  })
  .strict();
export type WatchTaskParams = z.infer<typeof WatchTaskParamsSchema>;

export const WatchGroupParamsSchema = z.object({ name: WatchGroupNameSchema }).strict();
export type WatchGroupParams = z.infer<typeof WatchGroupParamsSchema>;

export const UniverseQuerySchema = z.object({ market: z.enum(['hk', 'us']) }).strict();
export type UniverseQuery = z.infer<typeof UniverseQuerySchema>;
