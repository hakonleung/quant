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
 * Result of a manual or scheduled cron scan
 * (`POST /api/orchestration/scan`). Reports how many jobs landed on
 * each queue after dedup; existing in-flight or pending jobs with the
 * same id are not re-counted.
 */
export const ScanResultSchema = z
  .object({
    traceId: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    elapsedMs: z.number().int().nonnegative(),
    metaEnqueued: z.number().int().nonnegative(),
    klineEnqueued: z.number().int().nonnegative(),
  })
  .strict();

export type ScanResult = z.infer<typeof ScanResultSchema>;
