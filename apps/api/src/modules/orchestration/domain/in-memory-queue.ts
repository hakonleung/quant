/**
 * In-process job queue with concurrency, dedup, delay, pause/resume,
 * per-task retry policy and a pool-level backoff hook
 * (`docs/modules/09-update-orchestration.md` §6).
 *
 * Stand-in for BullMQ. v1 is single-process and Redis is not available
 * in the dev environment; this lightweight in-memory queue preserves
 * the `JobProcessor` surface a future BullMQ adapter would implement.
 *
 * What's new vs the original draft:
 *   - `maxRetry` + `taskBackoff` — when a `processor.process()` rejects
 *     (or `failJob` is called explicitly), the queue applies the
 *     backoff policy and re-schedules until `attemptsMade > maxRetry`,
 *     at which point the job emits a terminal `failed` event and leaves
 *     the system.
 *   - `poolBackoff` — pool-class errors (connection abort, http proxy
 *     failures) trip the entire pool: dispatch pauses, in-flight jobs
 *     drain, then the queue waits a cooldown window before resuming.
 *     Independent of `taskBackoff`; the same failure increments both.
 *   - Terminal-event listeners — {@link BatchSettler} subscribes to
 *     know when every job in a tracked batch has left the queue.
 *
 * Pure with respect to the wider system: no Nest, no IO. Only impurity
 * is `setTimeout` for delayed/rescheduled jobs.
 */

import { ExponentialBackoff } from './backoff.js';
import { PoolBackoff, type PoolBackoffOptions } from './pool-backoff.js';
import type { AddOptions, JobEnvelope, JobProcessor, JobTerminalEvent, ReQueue } from './types.js';

interface Pending<T> {
  readonly id: string;
  readonly data: T;
  attemptsMade: number;
}

export interface TaskBackoffSpec {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
  readonly jitterRatio: number;
  /** [0, 1) random source. Defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface InMemoryQueueOptions {
  readonly name: string;
  /** Default 8 (CLAUDE.md §9.3 — must match operational profile). */
  readonly concurrency: number;
  /**
   * Max retries per envelope. `Infinity` (default) preserves the
   * legacy "processor calls `reschedule` itself" semantics. When set,
   * `failJob()` / a thrown processor consults this to decide whether
   * to re-queue with `taskBackoff` or emit a terminal `failed` event.
   */
  readonly maxRetry?: number;
  readonly taskBackoff?: TaskBackoffSpec;
  readonly poolBackoff?: PoolBackoffOptions;
}

export type TerminalListener<T> = (event: JobTerminalEvent<T>) => void;

export class InMemoryQueue<T> implements ReQueue<T> {
  private readonly waiting: Pending<T>[] = [];
  private readonly known = new Set<string>(); // ids currently waiting OR active OR delayed
  /**
   * Ids whose currently-running processor invocation has already called
   * `reschedule()`. The success path checks this set to know the
   * envelope is *not* terminal even though the promise resolved (legacy
   * pattern: worker catches transient error and returns without
   * throwing). Cleared either in {@link reschedule} (re-armed for the
   * next attempt) or by the success-handler when no reschedule was
   * recorded.
   */
  private readonly rescheduledInFlight = new Set<string>();
  private active = 0;
  private paused = false;
  private processor: JobProcessor<T> | null = null;
  private nextSeq = 0;
  private readonly terminalListeners: TerminalListener<T>[] = [];
  private readonly taskBackoff: ExponentialBackoff | null;
  private readonly maxRetry: number;
  private readonly poolBackoff: PoolBackoff | null;

  constructor(private readonly options: InMemoryQueueOptions) {
    this.taskBackoff = options.taskBackoff ? new ExponentialBackoff(options.taskBackoff) : null;
    this.maxRetry = options.maxRetry ?? Number.POSITIVE_INFINITY;
    this.poolBackoff = options.poolBackoff
      ? new PoolBackoff(options.poolBackoff, {
          pause: () => this.pause(),
          inFlight: () => this.active,
          resume: () => this.resume(),
        })
      : null;
  }

  setProcessor(processor: JobProcessor<T>): void {
    this.processor = processor;
    this.drain();
  }

  /** Subscribe to job terminal events. Returns an unsubscribe handle. */
  onTerminal(listener: TerminalListener<T>): () => void {
    this.terminalListeners.push(listener);
    return (): void => {
      const idx = this.terminalListeners.indexOf(listener);
      if (idx >= 0) this.terminalListeners.splice(idx, 1);
    };
  }

  get name(): string {
    return this.options.name;
  }

  get pending(): number {
    return this.waiting.length;
  }

  get inFlight(): number {
    return this.active;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  add(data: T, options: AddOptions = {}): boolean {
    const id = options.id ?? `${this.options.name}:${String(this.nextSeq++)}`;
    if (this.known.has(id)) return false;
    this.known.add(id);
    if (options.delayMs !== undefined && options.delayMs > 0) {
      setTimeout(() => {
        this.waiting.push({ id, data, attemptsMade: 0 });
        this.drain();
      }, options.delayMs);
      return true;
    }
    this.waiting.push({ id, data, attemptsMade: 0 });
    this.drain();
    return true;
  }

  addBulk(items: ReadonlyArray<{ readonly data: T; readonly options?: AddOptions }>): number {
    let added = 0;
    for (const item of items) {
      if (this.add(item.data, item.options)) added += 1;
    }
    return added;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.drain();
  }

  reschedule(envelope: JobEnvelope<T>, delayMs: number): void {
    // The id stays "known" so dedup still applies during the delay window.
    this.rescheduledInFlight.add(envelope.id);
    setTimeout(
      () => {
        this.waiting.push({
          id: envelope.id,
          data: envelope.data,
          attemptsMade: envelope.attemptsMade,
        });
        this.drain();
      },
      Math.max(0, delayMs),
    );
  }

  /**
   * Public failure hook for processors that prefer explicit signalling
   * over throwing. Applies retry policy and (if classified) trips the
   * pool. Equivalent to the queue's own catch path.
   */
  failJob(envelope: JobEnvelope<T>, err: unknown): void {
    this.handleFailure(envelope, err);
  }

  private drain(): void {
    if (this.processor === null || this.paused) return;
    while (this.active < this.options.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next === undefined) break;
      this.active += 1;
      const envelope: JobEnvelope<T> = {
        id: next.id,
        data: next.data,
        attemptsMade: next.attemptsMade + 1,
      };
      this.runOne(envelope);
    }
  }

  private runOne(envelope: JobEnvelope<T>): void {
    const processor = this.processor;
    if (processor === null) {
      this.active -= 1;
      return;
    }
    // Per-attempt flag — cleared at the boundary so a previous attempt's
    // reschedule signal doesn't leak into this attempt's success path.
    this.rescheduledInFlight.delete(envelope.id);
    processor
      .process(envelope, this)
      .then(
        () => {
          if (this.rescheduledInFlight.delete(envelope.id)) {
            // Processor caught a transient error and re-armed via
            // `reschedule()`. Not terminal; the id stays in `known`.
            return;
          }
          this.emitTerminal(envelope, 'succeeded');
        },
        (err: unknown) => {
          // Clear any stale in-flight reschedule flag — failure path
          // takes over the retry decision.
          this.rescheduledInFlight.delete(envelope.id);
          this.handleFailure(envelope, err);
        },
      )
      .finally(() => {
        this.active -= 1;
        this.drain();
      });
  }

  private handleFailure(envelope: JobEnvelope<T>, err: unknown): void {
    // Pool-class failures: trip the pool. The pool's lock is independent
    // of the per-job retry decision — we still apply the task policy
    // to this envelope so it eventually retries (after pool resumes)
    // or terminates by attempt count.
    const poolTripped =
      this.poolBackoff !== null && this.poolBackoff.classify(err) && !this.poolBackoff.isLocked;
    if (poolTripped && this.poolBackoff !== null) {
      this.poolBackoff.trip();
    } else if (this.poolBackoff !== null && !this.poolBackoff.classify(err)) {
      // First task-level success-or-non-pool-failure after a streak resets
      // the trip counter only when the pool is not currently locked
      // (PoolBackoff.reset() is a no-op while locked).
      this.poolBackoff.reset();
    }

    if (envelope.attemptsMade < this.maxRetry) {
      const delay = this.taskBackoff ? this.taskBackoff.next(envelope.attemptsMade) : 0;
      this.reschedule(envelope, delay);
      return;
    }
    // Retries exhausted — terminal failure.
    this.emitTerminal(envelope, 'failed');
  }

  private emitTerminal(envelope: JobEnvelope<T>, reason: 'succeeded' | 'failed'): void {
    this.known.delete(envelope.id);
    if (reason === 'succeeded' && this.poolBackoff !== null) {
      this.poolBackoff.reset();
    }
    for (const listener of this.terminalListeners) {
      try {
        listener({ queueName: this.options.name, envelope, reason });
      } catch {
        // listener failures must not poison the queue
      }
    }
  }
}
