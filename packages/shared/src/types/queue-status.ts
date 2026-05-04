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
 * Acknowledgement for a fire-and-forget scan trigger
 * (`POST /api/orchestration/scan`). The actual scan runs in the
 * background — bulk financials sync alone is a 10–15s Flight RPC
 * and the per-stock follow-up enrichment can take minutes. Clients
 * observe progress via the queue SSE stream and the meta/kline
 * counter capsules in the footer; they do **not** await this call.
 */
export const ScanAcceptedSchema = z
  .object({
    kind: ScanKindSchema,
    traceId: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    /**
     * `true` when this call started a fresh scan; `false` when it
     * coalesced with one already in flight for the same kind. Either
     * way the SSE stream is the single source of truth for progress.
     */
    started: z.boolean(),
  })
  .strict();

export type ScanAccepted = z.infer<typeof ScanAcceptedSchema>;

/**
 * Internal post-scan summary, produced by `CronOrchestrator.triggerScan`
 * for log lines and tests. **Not** part of the HTTP contract anymore —
 * the manual-trigger endpoint returns a {@link ScanAccepted} immediately;
 * progress lives in the SSE stream.
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
