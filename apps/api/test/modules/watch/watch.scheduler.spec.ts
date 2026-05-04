import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpotQuote, StockBasic, WatchTask, WatchMarket } from '@quant/shared';
import { WatchScheduler } from '../../../src/modules/watch/watch.scheduler.js';
import { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import type { WatchQuotePort } from '../../../src/modules/watch/domain/watch-port.js';
import type { WatchNotifier } from '../../../src/modules/watch/watch-notifier.js';

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

class FakeNotifier implements WatchNotifier {
  sent: string[] = [];
  async send(text: string): Promise<void> {
    this.sent.push(text);
  }
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'watch-'));
}

function quote(overrides: Partial<SpotQuote> = {}): SpotQuote {
  return {
    market: 'a',
    code: '600000',
    last: '10.50',
    dayHigh: '10.80',
    dayLow: '10.00',
    prevClose: '10.00',
    ts: '2026-05-04T01:30:00Z',
    ...overrides,
  };
}

function task(overrides: Partial<WatchTask> = {}): WatchTask {
  return {
    market: 'a',
    code: '600000',
    name: '浦发银行',
    conditions: [{ kind: 'pct', baseline: 'prev_close', thresholdPct: '5' }],
    intervalSec: 5,
    pushIntervalSec: 60,
    remaining: null,
    notifySlack: true,
    enabled: true,
    createdAt: '2026-05-04T00:00:00Z',
    lastTickAt: null,
    lastPushAt: null,
    hitCount: 0,
    ...overrides,
  };
}

// 2026-05-04 (Mon) 01:30 UTC = 09:30 BJT — A-market open.
const TICK_TIME = new Date('2026-05-04T01:30:00Z');

async function newScheduler(
  store: WatchTaskStore,
  port: WatchQuotePort,
  notifier: WatchNotifier,
): Promise<WatchScheduler> {
  const sched = new WatchScheduler(store, port, notifier);
  // Bypass setInterval — tests drive ticks manually.
  await store.load();
  return sched;
}

describe('WatchScheduler.tick', () => {
  it('fetches quote and pushes when condition hits', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task());

    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    expect(port.calls).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toContain('600000');
    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(1);
    expect(after?.lastPushAt).toBe(TICK_TIME.toISOString());
  });

  it('skips push when within pushIntervalSec window', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(
      task({
        lastPushAt: new Date(TICK_TIME.getTime() - 30_000).toISOString(),
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    expect(notifier.sent).toHaveLength(0);
    expect(store.get('a', '600000')?.hitCount).toBe(1);
  });

  it('decrements remaining and disables on hit zero', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task({ remaining: 1 }));
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    const after = store.get('a', '600000');
    expect(after?.remaining).toBe(0);
    expect(after?.enabled).toBe(false);
  });

  it('quote failure bumps lastTickAt without throwing', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task());
    const port = new FakeQuotePort();
    port.failNext = true;
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await expect(sched.tick(TICK_TIME)).resolves.toBeUndefined();
    expect(store.get('a', '600000')?.lastTickAt).toBe(TICK_TIME.toISOString());
    expect(notifier.sent).toHaveLength(0);
  });

  it('skips tasks while market is closed', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task());
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    // Saturday — A-share closed.
    await sched.tick(new Date('2026-05-09T01:30:00Z'));

    expect(port.calls).toHaveLength(0);
  });
});
