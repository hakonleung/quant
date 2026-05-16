/**
 * Watch transport handling — post-refactor the pool-level backoff lives
 * inside `InMemoryQueue`'s `poolBackoff` config (shared with the
 * orchestration queues), so the tests target the queue + classifier
 * directly. `WatchWorker` is responsible only for re-throwing transport
 * errors so the queue trips its pool.
 */

import { Inject, Injectable } from '@nestjs/common';
import { QuantError } from '@quant/shared';

import {
  isPoolLevelError,
  isPyFlightDown,
  isRateLimitError,
  isTransportError,
} from '../../../src/adapters/flight/flight-errors.js';
import { InMemoryQueue } from '../../../src/modules/orchestration/domain/in-memory-queue.js';
import type {
  JobEnvelope,
  JobProcessor,
  ReQueue,
} from '../../../src/modules/orchestration/domain/types.js';

void Inject;
void Injectable;

interface TestJob {
  readonly kind: 'test';
  readonly id: string;
}

class FakeProcessor implements JobProcessor<TestJob> {
  errors: Error[] = [];
  ok: string[] = [];
  inflight = 0;
  peakInflight = 0;
  gate: Promise<void> | null = null;

  async process(job: JobEnvelope<TestJob>, _q: ReQueue<TestJob>): Promise<void> {
    this.inflight += 1;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
    try {
      if (this.gate !== null) await this.gate;
      const err = this.errors.shift();
      if (err !== undefined) throw err;
      this.ok.push(job.data.id);
    } finally {
      this.inflight -= 1;
    }
  }
}

function transportErr(): QuantError {
  return new QuantError('WATCH_QUOTE_UPSTREAM_FAIL', 'aborted', {
    market: 'us',
    code: 'AAPL',
    reason: 'transport',
  });
}

function rateLimitErr(): QuantError {
  return new QuantError('WATCH_QUOTE_UPSTREAM_FAIL', 'rate-limited by Yahoo', {
    market: 'us',
    code: 'AAPL',
    reason: 'rate_limited',
    backend: 'yfinance_watch',
  });
}

describe('flight error classifiers', () => {
  it('isTransportError recognises tunneled transport reason', () => {
    expect(isTransportError(transportErr())).toBe(true);
    expect(isTransportError(new Error('generic'))).toBe(false);
  });
  it('isRateLimitError recognises tunneled rate-limit reason', () => {
    expect(isRateLimitError(rateLimitErr())).toBe(true);
    expect(isRateLimitError(transportErr())).toBe(false);
    expect(isRateLimitError(new Error('generic'))).toBe(false);
  });
  it('isPyFlightDown matches ECONNRESET / ECONNREFUSED', () => {
    expect(isPyFlightDown(new Error('connect ECONNREFUSED 127.0.0.1:8815'))).toBe(true);
    expect(isPyFlightDown(new Error('socket hang up'))).toBe(true);
    expect(isPyFlightDown(new Error('generic'))).toBe(false);
  });
  it('isPoolLevelError is the union of py-down, transport, and rate-limit', () => {
    expect(isPoolLevelError(transportErr())).toBe(true);
    expect(isPoolLevelError(rateLimitErr())).toBe(true);
    expect(isPoolLevelError(new Error('ECONNRESET'))).toBe(true);
    expect(isPoolLevelError(new Error('boom'))).toBe(false);
  });
});

describe('InMemoryQueue pool-backoff', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function newQueue(processor: JobProcessor<TestJob>): InMemoryQueue<TestJob> {
    const q = new InMemoryQueue<TestJob>({
      name: 'watch-test',
      concurrency: 4,
      maxRetry: 3,
      taskBackoff: { baseMs: 1_000, factor: 2, maxMs: 5_000, jitterRatio: 0 },
      poolBackoff: {
        baseMs: 3_000,
        factor: 2,
        maxMs: 12_000,
        jitterRatio: 0,
        isPoolError: isPoolLevelError,
      },
    });
    q.setProcessor(processor);
    return q;
  }

  it('trips the pool on transport error and pauses dispatch', async () => {
    const proc = new FakeProcessor();
    proc.errors.push(transportErr());
    const q = newQueue(proc);
    q.add({ kind: 'test', id: 'first' }, { id: 'first' });
    await jest.advanceTimersByTimeAsync(0);
    expect(q.isPaused).toBe(true);

    // Even after enqueueing more work, dispatch stays paused.
    q.add({ kind: 'test', id: 'second' }, { id: 'second' });
    await jest.advanceTimersByTimeAsync(100);
    expect(proc.ok).toHaveLength(0);

    // Cooldown elapses → resume → second runs.
    proc.errors = [];
    await jest.advanceTimersByTimeAsync(3_500);
    expect(q.isPaused).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(proc.ok).toContain('second');
  });

  it('non-pool error does NOT trip the pool — just retries with task backoff', async () => {
    const proc = new FakeProcessor();
    proc.errors.push(new Error('plain boom'));
    const q = newQueue(proc);
    q.add({ kind: 'test', id: 'a' }, { id: 'a' });
    await jest.advanceTimersByTimeAsync(0);
    expect(q.isPaused).toBe(false);
    // First retry kicks after taskBackoff (1s).
    await jest.advanceTimersByTimeAsync(1_100);
    expect(proc.ok).toContain('a');
  });

  it('respects maxRetry — emits terminal `failed` after exhaustion', async () => {
    const proc = new FakeProcessor();
    proc.errors = [new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom')];
    const q = newQueue(proc);
    const terminals: string[] = [];
    q.onTerminal((ev) => {
      terminals.push(`${ev.reason}:${ev.envelope.id}`);
    });
    q.add({ kind: 'test', id: 'doomed' }, { id: 'doomed' });
    // Drive through three retries (1s, 2s, 4s) plus the final attempt.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(terminals).toContain('failed:doomed');
  });
});
