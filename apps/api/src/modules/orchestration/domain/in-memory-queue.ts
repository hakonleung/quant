/**
 * In-process job queue with concurrency, dedup, delay, and pause/resume.
 *
 * Stand-in for BullMQ described in `docs/modules/09-update-orchestration.md` §2.
 * The doc mandates BullMQ + Redis for production multi-process deploys; v1
 * is single-process and Redis is not available in the dev environment, so
 * this lightweight in-memory queue satisfies the orchestration semantics
 * (concurrency cap, jobId dedup, delayed re-enqueue, pause) while
 * preserving the same `JobProcessor` surface a future BullMQ adapter
 * would implement.
 *
 * Pure with respect to the wider system: no Nest, no IO. The only
 * impurity is `setTimeout` for delayed jobs.
 */

import type { AddOptions, JobEnvelope, JobProcessor, ReQueue } from './types.js';

interface Pending<T> {
  readonly id: string;
  readonly data: T;
  attemptsMade: number;
}

export interface InMemoryQueueOptions {
  readonly name: string;
  readonly concurrency: number;
}

export class InMemoryQueue<T> implements ReQueue<T> {
  private readonly waiting: Pending<T>[] = [];
  private readonly known = new Set<string>(); // ids currently waiting OR active OR delayed
  private active = 0;
  private paused = false;
  private processor: JobProcessor<T> | null = null;
  private nextSeq = 0;

  constructor(private readonly options: InMemoryQueueOptions) {}

  setProcessor(processor: JobProcessor<T>): void {
    this.processor = processor;
    this.drain();
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
    processor
      .process(envelope, this)
      .catch(() => {
        // Processor is responsible for its own logging; the queue does
        // not retry automatically (use `reschedule` for backoff).
      })
      .finally(() => {
        this.active -= 1;
        // Drop the id once the job leaves the system so future enqueues
        // for the same key are accepted.
        this.known.delete(envelope.id);
        this.drain();
      });
  }
}
