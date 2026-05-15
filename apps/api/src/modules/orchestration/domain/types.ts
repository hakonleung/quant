/**
 * Orchestration job + queue types (modules/09-update-orchestration.md §6).
 *
 * Pure types only — no Nest, no IO. Reusable across worker
 * implementations and tests.
 *
 * Job design — one *package* per code:
 *
 *   - `MetaJob` covers basic-info enrichment + financials + valuation
 *     recompute (pe/pb) for one A-share code. Whichever sub-steps the
 *     code actually needs are signalled by the `needBasic` /
 *     `needFinancials` flags so the cron can collapse two cache misses
 *     into one queue entry.
 *
 *   - `KlineJob` covers kline sync + post-hook `upsert_stock_metrics`
 *     (20d% / ma* / ret_*) for one code, atomic.
 *
 * Both carry an optional `batchId`: when present (16:00 cron / manual
 * `/scan`), the {@link BatchSettler} listens for terminal events with
 * that id to fire blacklist + dynamic-sectors recompute as a single
 * tail-off. Jobs pushed by ad-hoc paths (controller refresh,
 * instructions handler) leave `batchId` undefined and do not trigger
 * settlement.
 */

export interface MetaJob {
  readonly kind: 'meta_pkg';
  readonly code: string;
  readonly needBasic: boolean;
  readonly needFinancials: boolean;
  readonly traceId: string;
  readonly batchId?: string;
}

export interface KlineJob {
  readonly kind: 'kline_pkg';
  readonly code: string;
  readonly traceId: string;
  readonly batchId?: string;
}

export interface JobEnvelope<T> {
  readonly id: string;
  readonly data: T;
  readonly attemptsMade: number;
}

export interface AddOptions {
  /** Optional dedup key: if a job with this id is queued/active, skip. */
  readonly id?: string;
  /** Delay in ms before the job becomes eligible to run. */
  readonly delayMs?: number;
}

/**
 * Why a job left the system. Drives {@link BatchSettler} accounting:
 * both `succeeded` and `failed` count as terminal (one less remaining
 * job for the batch). `retried` is *not* terminal — the same envelope
 * id is back in `waiting`.
 */
export type JobTerminalReason = 'succeeded' | 'failed';

export interface JobTerminalEvent<T> {
  readonly queueName: string;
  readonly envelope: JobEnvelope<T>;
  readonly reason: JobTerminalReason;
}

export interface JobProcessor<T> {
  /**
   * Process a job. Throw to mark the attempt failed — the queue then
   * applies {@link InMemoryQueueOptions.maxRetry} /
   * {@link InMemoryQueueOptions.taskBackoff} to decide retry vs
   * terminal-fail, and consults the pool-backoff classifier to decide
   * whether to lock the whole pool.
   *
   * Callers MAY still invoke `queue.reschedule()` directly to apply a
   * custom delay regardless of the queue policy.
   */
  process(job: JobEnvelope<T>, queue: ReQueue<T>): Promise<void>;
}

export interface ReQueue<T> {
  /** Re-schedule the same payload after `delayMs` (custom backoff). */
  reschedule(envelope: JobEnvelope<T>, delayMs: number): void;
}
