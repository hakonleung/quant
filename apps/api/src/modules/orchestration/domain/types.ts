/**
 * Orchestration job + queue types (modules/09-update-orchestration.md §6).
 *
 * Pure types only — no Nest, no IO. Reusable across worker
 * implementations and tests.
 */

export type MetaJob =
  | { readonly kind: 'enrich'; readonly code: string; readonly traceId: string }
  | { readonly kind: 'full_sync'; readonly traceId: string };

export type KlineJob =
  | { readonly kind: 'sync'; readonly code: string; readonly traceId: string }
  | { readonly kind: 'recompute'; readonly code: string; readonly traceId: string };

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

export interface JobProcessor<T> {
  /**
   * Process a job. Throw to mark failed (non-retryable here — the
   * processor itself decides whether to re-enqueue with a delay via the
   * second argument).
   */
  process(job: JobEnvelope<T>, queue: ReQueue<T>): Promise<void>;
}

export interface ReQueue<T> {
  /** Re-schedule the same payload after `delayMs` (used for backoff). */
  reschedule(envelope: JobEnvelope<T>, delayMs: number): void;
}
