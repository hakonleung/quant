/**
 * Watch worker — fetch + evaluate + hit pipeline.
 *
 * Post-refactor, `WatchScheduler` is a pure producer (push due tasks
 * into per-market queues) and `WatchWorker` owns the actual per-task
 * fetch + evaluate + hit-batching path. These tests target the worker
 * directly so the assertions don't depend on the queue's microtask
 * scheduling.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpotQuote, StockBasic, WatchTask, WatchMarket } from '@quant/shared';
import type { ChannelOutboundRequest, ChannelOutboundResponse } from '@quant/shared';

import type { AuthConfigShape } from '../../../src/modules/auth/config/auth.config.js';
import type { ChannelService } from '../../../src/modules/channel/channel.service.js';
import type { JobEnvelope, ReQueue } from '../../../src/modules/orchestration/domain/types.js';
import { WatchGroupStore } from '../../../src/modules/watch/watch-group.store.js';
import { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import type { WatchJob } from '../../../src/modules/watch/domain/watch-job.js';
import { WatchWorker } from '../../../src/modules/watch/watch-worker.js';
import type { WatchQuotePort } from '../../../src/modules/watch/domain/watch-port.js';
import { makeUserBlobStore } from '../../fakes/in-memory-user-blob.store.js';

function makeWatchStores(_cfgVal: AuthConfigShape): {
  store: WatchTaskStore;
  groups: WatchGroupStore;
} {
  const blob = makeUserBlobStore();
  return {
    store: new WatchTaskStore(blob.store),
    groups: new WatchGroupStore(blob.store),
  };
}

const USER = 'admin';

class FakeQuotePort implements WatchQuotePort {
  responses: SpotQuote[] = [];
  failNext = false;
  calls: Array<{ market: WatchMarket; code: string }> = [];
  async fetchOne(market: WatchMarket, code: string): Promise<SpotQuote> {
    this.calls.push({ market, code });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('upstream boom');
    }
    const next = this.responses.shift();
    if (next === undefined) throw new Error('no canned response');
    return next;
  }
  async refreshUniverse(): Promise<readonly StockBasic[]> {
    return [];
  }
}

class FakeNotifier {
  sent: Array<{ text: string; kind: string }> = [];
  async broadcast(req: ChannelOutboundRequest): Promise<ChannelOutboundResponse> {
    this.sent.push({ text: req.text, kind: req.kind });
    return { accepted: [], activityIds: [] };
  }
  async send(): Promise<ChannelOutboundResponse> {
    return { accepted: [], activityIds: [] };
  }
}

const NOOP_QUEUE: ReQueue<WatchJob> = {
  reschedule: (): void => undefined,
};

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'watch-'));
}

function cfg(dataRoot: string): AuthConfigShape {
  return {
    mode: 'disabled',
    nextauthSecret: null,
    dataRoot,
    adminUserId: 'admin',
    adminUserIds: new Set<string>(),
  };
}

function quote(overrides: Partial<SpotQuote> = {}): SpotQuote {
  return {
    market: 'a',
    code: '600000',
    last: '10.50',
    dayHigh: '10.80',
    dayLow: '10.00',
    prevClose: '10.00',
    amount: '10500000',
    volume: '1000000',
    ts: '2026-05-04T01:30:00Z',
    ...overrides,
  };
}

function task(overrides: Partial<WatchTask> = {}): WatchTask {
  return {
    idx: 1,
    market: 'a',
    code: '600000',
    name: '浦发银行',
    groupName: 'default',
    conditions: [{ kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '5' }],
    intervalSec: 1,
    pushIntervalSec: 60,
    remaining: null,
    notifySlack: true,
    enabled: true,
    createdAt: '2026-05-04T00:00:00Z',
    lastTickAt: null,
    lastPushAt: null,
    lastSampleAt: null,
    hitCount: 0,
    lastHitPrice: null,
    ...overrides,
  };
}

const FROZEN_NOW = new Date('2026-05-04T01:30:00Z');

let realNow: () => Date;

function newWorker(
  store: WatchTaskStore,
  port: WatchQuotePort,
  notifier: FakeNotifier,
): WatchWorker {
  return new WatchWorker(
    port,
    { loadMaRef: async () => null },
    notifier as unknown as ChannelService,
    store,
  );
}

function envelope(market: WatchMarket, code: string): JobEnvelope<WatchJob> {
  return {
    id: `watch:${USER}:${market}:${code}`,
    data: { kind: 'watch_eval', userId: USER, market, code },
    attemptsMade: 1,
  };
}

async function buildEnv(seed: WatchTask): Promise<{
  store: WatchTaskStore;
  groups: WatchGroupStore;
  root: string;
}> {
  const root = await tmpRoot();
  const { store, groups } = makeWatchStores(cfg(root));
  await store.upsert(USER, seed);
  return { store, groups, root };
}

describe('WatchWorker.process', () => {
  beforeAll(() => {
    realNow = (): Date => new Date();
    // Freeze `new Date()` to TICK_TIME so the worker's `now` is stable.
    jest.useFakeTimers().setSystemTime(FROZEN_NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
    void realNow;
  });
  beforeEach(() => jest.setSystemTime(FROZEN_NOW));

  it('fetches quote and pushes when condition hits (no prior hit)', async () => {
    const { store } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const worker = newWorker(store, port, notifier);

    await worker.process(envelope('a', '600000'), NOOP_QUEUE);
    await jest.runAllTimersAsync();

    expect(port.calls).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.text).toContain('600000');
    const after = await store.get(USER, 'a', '600000');
    expect(after?.hitCount).toBe(1);
    expect(after?.lastHitPrice).toBe('10.5');
    expect(after?.lastPushAt).toBe(FROZEN_NOW.toISOString());
  });

  it('suppresses second hit when last drifts < 2% from lastHitPrice (price gate)', async () => {
    const { store } = await buildEnv(
      task({
        lastPushAt: new Date(FROZEN_NOW.getTime() - 120_000).toISOString(),
        lastHitPrice: '10.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.55' }));
    const notifier = new FakeNotifier();
    const worker = newWorker(store, port, notifier);

    await worker.process(envelope('a', '600000'), NOOP_QUEUE);

    expect(notifier.sent).toHaveLength(0);
    expect((await store.get(USER, 'a', '600000'))?.hitCount).toBe(1);
  });

  it('suppresses second hit while pushIntervalSec time gate is open', async () => {
    const { store } = await buildEnv(
      task({
        lastPushAt: new Date(FROZEN_NOW.getTime() - 30_000).toISOString(),
        lastHitPrice: '9.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.50' }));
    const notifier = new FakeNotifier();
    const worker = newWorker(store, port, notifier);

    await worker.process(envelope('a', '600000'), NOOP_QUEUE);

    expect(notifier.sent).toHaveLength(0);
    expect((await store.get(USER, 'a', '600000'))?.hitCount).toBe(1);
  });

  it('decrements remaining and disables on hit zero', async () => {
    const { store } = await buildEnv(task({ remaining: 1 }));
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const worker = newWorker(store, port, notifier);

    await worker.process(envelope('a', '600000'), NOOP_QUEUE);

    const after = await store.get(USER, 'a', '600000');
    expect(after?.remaining).toBe(0);
    expect(after?.enabled).toBe(false);
  });

  it('quote failure bumps lastTickAt and re-throws for queue to handle', async () => {
    const { store } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.failNext = true;
    const notifier = new FakeNotifier();
    const worker = newWorker(store, port, notifier);

    await expect(worker.process(envelope('a', '600000'), NOOP_QUEUE)).rejects.toThrow(
      'upstream boom',
    );
    expect((await store.get(USER, 'a', '600000'))?.lastTickAt).toBe(FROZEN_NOW.toISOString());
    expect(notifier.sent).toHaveLength(0);
  });

  it('treats quote with ts >30 min off server clock as no match', async () => {
    const { store } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.responses.push(quote({ ts: '2026-05-04T00:59:00Z' }));
    const notifier = new FakeNotifier();
    const worker = newWorker(store, port, notifier);

    await worker.process(envelope('a', '600000'), NOOP_QUEUE);

    const after = await store.get(USER, 'a', '600000');
    expect(after?.hitCount).toBe(0);
    expect(after?.lastTickAt).toBe(FROZEN_NOW.toISOString());
    expect(after?.lastSampleAt).toBeNull();
    expect(notifier.sent).toHaveLength(0);
  });

  it('batches two hits from same flush window into one broadcast', async () => {
    const root = await tmpRoot();
    const { store } = makeWatchStores(cfg(root));
    await store.upsert(USER, task({ code: '600000', name: '浦发银行', idx: 1 }));
    await store.upsert(USER, task({ code: '600519', name: '贵州茅台', idx: 2 }));
    const port = new FakeQuotePort();
    port.responses.push(quote({ code: '600000' }));
    port.responses.push(quote({ code: '600519', last: '1850.00', prevClose: '1750.00' }));
    const notifier = new FakeNotifier();
    const worker = newWorker(store, port, notifier);

    await worker.process(envelope('a', '600000'), NOOP_QUEUE);
    await worker.process(envelope('a', '600519'), NOOP_QUEUE);
    // Both hits queued but not yet sent.
    expect(notifier.sent).toHaveLength(0);
    await jest.runAllTimersAsync();
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.text).toContain('600000');
    expect(notifier.sent[0]?.text).toContain('600519');
  });
});
