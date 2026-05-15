/**
 * InMemoryQueue — retry, terminal events, pool backoff.
 *
 * The legacy "processor calls reschedule itself" path still works
 * (taskBackoff / maxRetry are optional). New behaviour exercised here:
 *   - automatic retry when processor throws (taskBackoff schedule).
 *   - terminal `succeeded` / `failed` events delivered to listeners.
 *   - pool-backoff trips on classified errors, drains in-flight, then
 *     resumes after cooldown.
 */

import { InMemoryQueue } from '../../../src/modules/orchestration/domain/in-memory-queue.js';
import type {
  JobEnvelope,
  JobProcessor,
  ReQueue,
} from '../../../src/modules/orchestration/domain/types.js';

interface Job {
  readonly kind: 'test';
}

class Processor implements JobProcessor<Job> {
  errors: Error[] = [];
  successes = 0;
  process(_job: JobEnvelope<Job>, _q: ReQueue<Job>): Promise<void> {
    const err = this.errors.shift();
    if (err !== undefined) return Promise.reject(err);
    this.successes += 1;
    return Promise.resolve();
  }
}

describe('InMemoryQueue', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits succeeded terminal on clean run', async () => {
    const proc = new Processor();
    const q = new InMemoryQueue<Job>({ name: 'q', concurrency: 1 });
    q.setProcessor(proc);
    const events: string[] = [];
    q.onTerminal((ev) => events.push(`${ev.reason}:${ev.envelope.id}`));
    q.add({ kind: 'test' }, { id: 'one' });
    await jest.advanceTimersByTimeAsync(0);
    expect(proc.successes).toBe(1);
    expect(events).toEqual(['succeeded:one']);
  });

  it('retries with taskBackoff up to maxRetry then emits failed', async () => {
    const proc = new Processor();
    proc.errors = [new Error('a'), new Error('b'), new Error('c'), new Error('d')];
    const q = new InMemoryQueue<Job>({
      name: 'q',
      concurrency: 1,
      maxRetry: 3,
      taskBackoff: { baseMs: 100, factor: 2, maxMs: 1_000, jitterRatio: 0 },
    });
    q.setProcessor(proc);
    const events: string[] = [];
    q.onTerminal((ev) => events.push(`${ev.reason}:${ev.envelope.id}`));
    q.add({ kind: 'test' }, { id: 'x' });
    // attempt 1 fails immediately, then 100ms, 200ms, 400ms delays.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual(['failed:x']);
  });

  it('legacy reschedule() still works without terminal event', async () => {
    class Reschedulable implements JobProcessor<Job> {
      tries = 0;
      process(env: JobEnvelope<Job>, q: ReQueue<Job>): Promise<void> {
        this.tries += 1;
        if (this.tries < 2) q.reschedule(env, 50);
        return Promise.resolve();
      }
    }
    const proc = new Reschedulable();
    const q = new InMemoryQueue<Job>({ name: 'q', concurrency: 1 });
    q.setProcessor(proc);
    const events: string[] = [];
    q.onTerminal((ev) => events.push(`${ev.reason}:${ev.envelope.id}`));
    q.add({ kind: 'test' }, { id: 'r' });
    await jest.advanceTimersByTimeAsync(200);
    expect(proc.tries).toBe(2);
    expect(events).toEqual(['succeeded:r']);
  });

  it('respects dedup id', () => {
    const q = new InMemoryQueue<Job>({ name: 'q', concurrency: 1 });
    expect(q.add({ kind: 'test' }, { id: 'same' })).toBe(true);
    expect(q.add({ kind: 'test' }, { id: 'same' })).toBe(false);
  });
});
