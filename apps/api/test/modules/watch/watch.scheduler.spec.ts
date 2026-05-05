import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpotQuote, StockBasic, WatchTask, WatchMarket } from '@quant/shared';
import { WatchScheduler } from '../../../src/modules/watch/watch.scheduler.js';
import { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import type { WatchQuotePort } from '../../../src/modules/watch/domain/watch-port.js';
import type { WatchNotifier } from '../../../src/modules/watch/watch-notifier.js';
import type { SlackPayload } from '../../../src/modules/watch/domain/format.js';

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
  sent: SlackPayload[] = [];
  async send(payload: SlackPayload): Promise<void> {
    this.sent.push(payload);
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
    lastMatchAt: null,
    hitCount: 0,
    lastSamplePrice: null,
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
    const header = notifier.sent[0]?.attachments[0]?.blocks[0];
    if (header?.type !== 'header') throw new Error('expected header block');
    expect(header.text.text).toContain('600000');
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

  it('treats two consecutive matches as one hit (edge-triggered)', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task());
    const port = new FakeQuotePort();
    port.responses.push(quote());
    port.responses.push(quote({ ts: '2026-05-04T01:30:30Z' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);
    // Second tick 30 s later — same trading day, last sample already
    // matched, so this MUST NOT count as a hit.
    await sched.tick(new Date(TICK_TIME.getTime() + 30_000));

    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('re-hits when match resumes after a no-match sample', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    // pushIntervalSec=5 so the second push isn't throttled by cadence —
    // we're testing the edge detector, not the push throttle.
    await store.upsert(task({ pushIntervalSec: 60 }));
    const port = new FakeQuotePort();
    // tick1: matches (+5%)
    port.responses.push(quote());
    // tick2: does NOT match (last == prevClose)
    port.responses.push(quote({ last: '10.00', ts: '2026-05-04T01:30:30Z' }));
    // tick3 (>60s later): matches again
    port.responses.push(quote({ ts: '2026-05-04T01:32:00Z' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);
    await sched.tick(new Date(TICK_TIME.getTime() + 30_000));
    await sched.tick(new Date(TICK_TIME.getTime() + 90_000));

    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(2);
    expect(notifier.sent).toHaveLength(2);
  });

  it('prev baseline: first tick has no cached sample → no match, no hit', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(
      task({
        conditions: [{ kind: 'pct', baseline: 'prev', op: 'lte', thresholdPct: '-2' }],
        pushIntervalSec: 60,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.00' })); // no prev cached
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(0);
    expect(after?.lastSamplePrice).toBe('10');
    expect(notifier.sent).toHaveLength(0);
  });

  it('prev baseline: every consecutive -2% step counts as a hit (no edge suppression)', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(
      task({
        conditions: [{ kind: 'pct', baseline: 'prev', op: 'lte', thresholdPct: '-2' }],
        pushIntervalSec: 1,
      }),
    );
    const port = new FakeQuotePort();
    // tick1: prev=null, last=10.00 → no match (caches 10.00)
    port.responses.push(quote({ last: '10.00' }));
    // tick2: prev=10.00, last=9.80 → -2% match → hit
    port.responses.push(quote({ last: '9.80', ts: '2026-05-04T01:30:30Z' }));
    // tick3: prev=9.80, last=9.604 → -2.0% match → hit (would be suppressed for non-prev baseline)
    port.responses.push(quote({ last: '9.604', ts: '2026-05-04T01:31:00Z' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);
    await sched.tick(new Date(TICK_TIME.getTime() + 30_000));
    await sched.tick(new Date(TICK_TIME.getTime() + 60_000));

    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(2);
    expect(notifier.sent).toHaveLength(2);
  });

  it('treats quote with ts >30 min off server clock as no match', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task());
    const port = new FakeQuotePort();
    // ts is 31 minutes earlier than the tick — stale.
    port.responses.push(quote({ ts: '2026-05-04T00:59:00Z' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(0);
    expect(after?.lastTickAt).toBe(TICK_TIME.toISOString());
    // No sample state recorded — stale quote must not pollute prev-baseline.
    expect(after?.lastSampleAt).toBeNull();
    expect(after?.lastSamplePrice).toBeNull();
    expect(notifier.sent).toHaveLength(0);
  });

  it('does not snapshot the task store when every market is closed', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task());
    const port = new FakeQuotePort();
    port.responses.push(quote());
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    // Saturday in BJT and outside US session → all three markets closed.
    await sched.tick(new Date('2026-05-09T05:00:00Z'));

    expect(port.calls).toHaveLength(0);
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
