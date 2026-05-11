/**
 * Watch scheduler — per-market transport breaker + fetch pool.
 *
 * Covers the failure modes that needed a dedicated suite:
 *   - QuantError({reason: 'transport'}) trips per-market cooldown
 *   - non-transport errors do NOT trip cooldown
 *   - a successful fetch resets the breaker
 *   - per-market in-flight fetch concurrency is bounded
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpotQuote, StockBasic, WatchTask, WatchMarket } from '@quant/shared';
import { QuantError, type ChannelOutboundRequest, type ChannelOutboundResponse } from '@quant/shared';

import type { AuthConfigShape } from '../../../src/modules/auth/config/auth.config.js';
import type { ChannelService } from '../../../src/modules/channel/channel.service.js';
import type { UserStore, UserRecord } from '../../../src/modules/auth/user.store.js';
import { WatchGroupStore } from '../../../src/modules/watch/watch-group.store.js';
import { WatchScheduler } from '../../../src/modules/watch/watch.scheduler.js';
import { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import type { WatchQuotePort } from '../../../src/modules/watch/domain/watch-port.js';

const USER = 'admin';

class FakeQuotePort implements WatchQuotePort {
  responses: SpotQuote[] = [];
  errors: Error[] = [];
  inFlight = 0;
  peakInFlight = 0;
  gate: Promise<void> | null = null;
  calls: Array<{ market: WatchMarket; code: string }> = [];
  async fetchOne(market: WatchMarket, code: string): Promise<SpotQuote> {
    this.calls.push({ market, code });
    this.inFlight += 1;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    try {
      if (this.gate !== null) await this.gate;
      const err = this.errors.shift();
      if (err !== undefined) throw err;
      const next = this.responses.shift();
      if (next === undefined) throw new Error('no canned response');
      return next;
    } finally {
      this.inFlight -= 1;
    }
  }
  async refreshUniverse(): Promise<readonly StockBasic[]> {
    return [];
  }
}

class FakeNotifier {
  async broadcast(_req: ChannelOutboundRequest): Promise<ChannelOutboundResponse> {
    return { accepted: [], activityIds: [] };
  }
  async send(): Promise<ChannelOutboundResponse> {
    return { accepted: [], activityIds: [] };
  }
}

class FakeUserStore {
  private readonly users: UserRecord[];
  constructor(ids: readonly string[]) {
    this.users = ids.map((id) => ({
      id,
      provider: 'admin',
      externalId: id,
      tenantKey: null,
      displayName: id,
      email: null,
      avatarUrl: null,
      createdAt: '2026-05-01T00:00:00Z',
      lastLoginAt: '2026-05-01T00:00:00Z',
    }));
  }
  list(): readonly UserRecord[] {
    return this.users;
  }
  get(id: string): UserRecord | null {
    return this.users.find((u) => u.id === id) ?? null;
  }
}

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'watch-transport-'));
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
    market: 'us',
    code: 'AAPL',
    last: '100.00',
    dayHigh: '101.00',
    dayLow: '99.00',
    prevClose: '99.50',
    amount: '10000000',
    volume: '100000',
    ts: '2026-05-05T14:00:00Z',
    ...overrides,
  };
}

function task(overrides: Partial<WatchTask> = {}): WatchTask {
  return {
    idx: 1,
    market: 'us',
    code: 'AAPL',
    name: 'Apple',
    groupName: 'default',
    conditions: [{ kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '5' }],
    intervalSec: 1,
    pushIntervalSec: 60,
    remaining: null,
    notifySlack: false,
    enabled: true,
    createdAt: '2026-05-05T00:00:00Z',
    lastTickAt: null,
    lastPushAt: null,
    lastSampleAt: null,
    hitCount: 0,
    lastHitPrice: null,
    ...overrides,
  };
}

function newScheduler(
  store: WatchTaskStore,
  groups: WatchGroupStore,
  port: WatchQuotePort,
  notifier: FakeNotifier,
  users: FakeUserStore,
): WatchScheduler {
  return new WatchScheduler(
    store,
    groups,
    port,
    notifier as unknown as ChannelService,
    users as unknown as UserStore,
  );
}

async function buildEnv(seed: WatchTask): Promise<{
  store: WatchTaskStore;
  groups: WatchGroupStore;
  users: FakeUserStore;
  root: string;
}> {
  const root = await tmpRoot();
  const store = new WatchTaskStore(cfg(root));
  const groups = new WatchGroupStore(cfg(root));
  await store.upsert(USER, seed);
  return { store, groups, users: new FakeUserStore([USER]), root };
}

function transportErr(): QuantError {
  return new QuantError('WATCH_QUOTE_UPSTREAM_FAIL', 'aborted', {
    market: 'us',
    code: 'AAPL',
    reason: 'transport',
  });
}

// 10:00 ET, US RTH open.
const TICK_AT = new Date('2026-05-05T14:00:00Z');

describe('WatchScheduler transport/cooldown/pool', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('trips per-market cooldown on QuantError(reason=transport) and skips next tick', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.errors.push(transportErr());
    const sched = newScheduler(store, groups, port, new FakeNotifier(), users);

    await sched.tick(TICK_AT);
    await jest.runAllTimersAsync();
    expect(port.calls).toHaveLength(1);

    // 1.5s in — well inside the 3s base cooldown → skipped.
    await sched.tick(new Date(TICK_AT.getTime() + 1_500));
    await jest.runAllTimersAsync();
    expect(port.calls).toHaveLength(1);
  });

  it('non-transport error does NOT trip cooldown', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.errors.push(new Error('generic boom'));
    port.responses.push(quote());
    const sched = newScheduler(store, groups, port, new FakeNotifier(), users);

    await sched.tick(TICK_AT);
    await jest.runAllTimersAsync();
    await sched.tick(new Date(TICK_AT.getTime() + 1_500));
    await jest.runAllTimersAsync();
    expect(port.calls).toHaveLength(2);
  });

  it('successful fetch resets prior cooldown', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.errors.push(transportErr());
    port.responses.push(quote());
    const sched = newScheduler(store, groups, port, new FakeNotifier(), users);

    await sched.tick(TICK_AT);
    await jest.runAllTimersAsync();
    // Past the 3s cooldown — second tick fetches and succeeds → reset.
    await sched.tick(new Date(TICK_AT.getTime() + 3_500));
    await jest.runAllTimersAsync();
    expect(port.calls).toHaveLength(2);

    // A fresh failure should trip BASE again (3s), not the doubled (6s).
    port.errors.push(transportErr());
    await sched.tick(new Date(TICK_AT.getTime() + 5_000));
    await jest.runAllTimersAsync();
    expect(port.calls).toHaveLength(3);
    await sched.tick(new Date(TICK_AT.getTime() + 6_500));
    await jest.runAllTimersAsync();
    expect(port.calls).toHaveLength(3); // still in the 3s cooldown window
  });

  it('caps per-market in-flight fetches at the pool size (8)', async () => {
    jest.useRealTimers();
    const root = await tmpRoot();
    const store = new WatchTaskStore(cfg(root));
    const groups = new WatchGroupStore(cfg(root));
    const port = new FakeQuotePort();
    for (let i = 0; i < 12; i++) {
      await store.upsert(USER, task({ code: `AAPL${String(i)}`, idx: i + 1 }));
      port.responses.push(quote({ code: `AAPL${String(i)}` }));
    }
    let release: (() => void) | null = null;
    port.gate = new Promise<void>((res) => {
      release = res;
    });
    const sched = newScheduler(store, groups, port, new FakeNotifier(), new FakeUserStore([USER]));
    const tickPromise = sched.tick(TICK_AT);
    // Poll until the pool fills — fs reads in `collectDue` take an
    // unpredictable number of microtask hops under full-suite scheduling.
    for (let i = 0; i < 200 && port.peakInFlight < 8; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(port.peakInFlight).toBe(8);
    release!();
    await tickPromise;
    expect(port.calls).toHaveLength(12);
  });
});
