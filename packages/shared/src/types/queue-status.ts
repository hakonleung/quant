/**
 * Cross-process contract for the orchestration queue snapshot stream
 * (`docs/modules/07-frontend.md` SSE addendum, `docs/modules/09-...md` §6).
 *
 * Mirrors the NestJS `QueueSnapshot` returned from
 * `GET /api/orchestration/queue` and emitted as SSE events on
 * `/api/orchestration/queue/stream`. Validated on the frontend before
 * entering React state so a contract drift fails loudly.
 */

import { z } from 'zod';

export const QueueSnapshotEntrySchema = z
  .object({
    name: z.string().min(1),
    pending: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    paused: z.boolean(),
  })
  .strict();

export type QueueSnapshotEntry = z.infer<typeof QueueSnapshotEntrySchema>;

export const QueueSnapshotSchema = z
  .object({
    ts: z.string().datetime({ offset: true }),
    queues: z.array(QueueSnapshotEntrySchema),
  })
  .strict();

export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>;

/**
 * Selector for {@link ScanResultSchema} requests. Manual triggers split
 * the meta and kline scans so a slow akshare kline pull doesn't gate
 * the (cheap) meta enrichment, and vice-versa. The daily 15:15 BJT
 * cron uses `'all'`.
 */
export const ScanKindSchema = z.enum(['meta', 'kline', 'all']);
export type ScanKind = z.infer<typeof ScanKindSchema>;

/**
 * Result of a manual or scheduled cron scan
 * (`POST /api/orchestration/scan`). Reports how many jobs landed on
 * each queue after dedup; existing in-flight or pending jobs with the
 * same id are not re-counted. The `kind` field echoes the trigger; for
 * `'meta'` `klineEnqueued` is always 0, and vice-versa.
 */
export const ScanResultSchema = z
  .object({
    kind: ScanKindSchema,
    traceId: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    elapsedMs: z.number().int().nonnegative(),
    metaEnqueued: z.number().int().nonnegative(),
    klineEnqueued: z.number().int().nonnegative(),
  })
  .strict();

export type ScanResult = z.infer<typeof ScanResultSchema>;
