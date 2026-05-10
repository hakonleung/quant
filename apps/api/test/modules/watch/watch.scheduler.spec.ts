import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpotQuote, StockBasic, WatchTask, WatchMarket } from '@quant/shared';
import type { ChannelOutboundRequest, ChannelOutboundResponse } from '@quant/shared';

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
    intervalSec: 5,
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

const TICK_TIME = new Date('2026-05-04T01:30:00Z');

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
  const users = new FakeUserStore([USER]);
  return { store, groups, users, root };
}

describe('WatchScheduler.tick', () => {
  it('fetches quote and pushes when condition hits (no prior hit)', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(TICK_TIME);

    expect(port.calls).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.text).toContain('600000');
    const after = await store.get(USER, 'a', '600000');
    expect(after?.hitCount).toBe(1);
    expect(after?.lastHitPrice).toBe('10.5');
    expect(after?.lastPushAt).toBe(TICK_TIME.toISOString());
  });

  it('suppresses second hit when last drifts < 2% from lastHitPrice (price gate)', async () => {
    const { store, groups, users } = await buildEnv(
      task({
        lastPushAt: new Date(TICK_TIME.getTime() - 120_000).toISOString(),
        lastHitPrice: '10.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.55' }));
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(TICK_TIME);

    expect(notifier.sent).toHaveLength(0);
    expect((await store.get(USER, 'a', '600000'))?.hitCount).toBe(1);
  });

  it('suppresses second hit while pushIntervalSec time gate is open', async () => {
    const { store, groups, users } = await buildEnv(
      task({
        lastPushAt: new Date(TICK_TIME.getTime() - 30_000).toISOString(),
        lastHitPrice: '9.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.50' }));
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(TICK_TIME);

    expect(notifier.sent).toHaveLength(0);
    expect((await store.get(USER, 'a', '600000'))?.hitCount).toBe(1);
  });

  it('fires when both gates clear (drift ≥ 2% AND interval elapsed)', async () => {
    const { store, groups, users } = await buildEnv(
      task({
        lastPushAt: new Date(TICK_TIME.getTime() - 120_000).toISOString(),
        lastHitPrice: '10.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.71' }));
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(TICK_TIME);

    expect(notifier.sent).toHaveLength(1);
    const after = await store.get(USER, 'a', '600000');
    expect(after?.hitCount).toBe(2);
    expect(after?.lastHitPrice).toBe('10.71');
  });

  it('decrements remaining and disables on hit zero', async () => {
    const { store, groups, users } = await buildEnv(task({ remaining: 1 }));
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(TICK_TIME);

    const after = await store.get(USER, 'a', '600000');
    expect(after?.remaining).toBe(0);
    expect(after?.enabled).toBe(false);
  });

  it('quote failure bumps lastTickAt without throwing', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.failNext = true;
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await expect(sched.tick(TICK_TIME)).resolves.toBeUndefined();
    expect((await store.get(USER, 'a', '600000'))?.lastTickAt).toBe(TICK_TIME.toISOString());
    expect(notifier.sent).toHaveLength(0);
  });

  it('trend baseline (window in seconds) only fires once a sample is old enough', async () => {
    const { store, groups, users } = await buildEnv(
      task({
        conditions: [{ kind: 'pct', baseline: 'trend', op: 'gte', thresholdPct: '5', window: 30 }],
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.00', ts: '2026-05-04T01:30:00Z' }));
    port.responses.push(quote({ last: '10.10', ts: '2026-05-04T01:30:30Z' }));
    port.responses.push(quote({ last: '10.62', ts: '2026-05-04T01:31:00Z' }));
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(TICK_TIME);
    await sched.tick(new Date(TICK_TIME.getTime() + 30_000));
    await sched.tick(new Date(TICK_TIME.getTime() + 60_000));

    expect(notifier.sent).toHaveLength(1);
    expect((await store.get(USER, 'a', '600000'))?.hitCount).toBe(1);
  });

  it('treats quote with ts >30 min off server clock as no match', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.responses.push(quote({ ts: '2026-05-04T00:59:00Z' }));
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(TICK_TIME);

    const after = await store.get(USER, 'a', '600000');
    expect(after?.hitCount).toBe(0);
    expect(after?.lastTickAt).toBe(TICK_TIME.toISOString());
    expect(after?.lastSampleAt).toBeNull();
    expect(notifier.sent).toHaveLength(0);
  });

  it('does not snapshot the task store when every market is closed', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(new Date('2026-05-09T05:00:00Z'));

    expect(port.calls).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it('skips tasks while market is closed', async () => {
    const { store, groups, users } = await buildEnv(task());
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = newScheduler(store, groups, port, notifier, users);

    await sched.tick(new Date('2026-05-09T01:30:00Z'));

    expect(port.calls).toHaveLength(0);
  });
});
