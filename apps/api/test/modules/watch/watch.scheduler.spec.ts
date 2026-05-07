import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpotQuote, StockBasic, WatchTask, WatchMarket } from '@quant/shared';
import { WatchScheduler } from '../../../src/modules/watch/watch.scheduler.js';
import { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import type {
  ChannelOutboundRequest,
  ChannelOutboundResponse,
} from '@quant/shared';
import type { WatchQuotePort } from '../../../src/modules/watch/domain/watch-port.js';
import type { ChannelService } from '../../../src/modules/channel/channel.service.js';

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
    amount: '10500000',
    volume: '1000000',
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
    hitCount: 0,
    lastHitPrice: null,
    ...overrides,
  };
}

// 2026-05-04 (Mon) 01:30 UTC = 09:30 BJT — A-market open.
const TICK_TIME = new Date('2026-05-04T01:30:00Z');

async function newScheduler(
  store: WatchTaskStore,
  port: WatchQuotePort,
  notifier: FakeNotifier,
): Promise<WatchScheduler> {
  const sched = new WatchScheduler(store, port, notifier as unknown as ChannelService);
  await store.load();
  return sched;
}

describe('WatchScheduler.tick', () => {
  it('fetches quote and pushes when condition hits (no prior hit)', async () => {
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
    expect(notifier.sent[0]?.text).toContain('600000');
    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(1);
    expect(after?.lastHitPrice).toBe('10.5');
    expect(after?.lastPushAt).toBe(TICK_TIME.toISOString());
  });

  it('suppresses second hit when last drifts < 2% from lastHitPrice (price gate)', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(
      task({
        // Past pushIntervalSec so only the price gate is in play.
        lastPushAt: new Date(TICK_TIME.getTime() - 120_000).toISOString(),
        lastHitPrice: '10.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.55' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    expect(notifier.sent).toHaveLength(0);
    expect(store.get('a', '600000')?.hitCount).toBe(1);
  });

  it('suppresses second hit while pushIntervalSec time gate is open', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(
      task({
        // 30 s ago — well inside pushIntervalSec=60.
        lastPushAt: new Date(TICK_TIME.getTime() - 30_000).toISOString(),
        // Price drifted >> 2 % so the price gate alone wouldn't suppress.
        lastHitPrice: '9.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.50' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    expect(notifier.sent).toHaveLength(0);
    expect(store.get('a', '600000')?.hitCount).toBe(1);
  });

  it('fires when both gates clear (drift ≥ 2% AND interval elapsed)', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(
      task({
        lastPushAt: new Date(TICK_TIME.getTime() - 120_000).toISOString(),
        lastHitPrice: '10.5',
        hitCount: 1,
      }),
    );
    const port = new FakeQuotePort();
    port.responses.push(quote({ last: '10.71' })); // +2.0 % drift
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    expect(notifier.sent).toHaveLength(1);
    expect(store.get('a', '600000')?.hitCount).toBe(2);
    expect(store.get('a', '600000')?.lastHitPrice).toBe('10.71');
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

  it('trend baseline (window in seconds) only fires once a sample is old enough', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    // window = 30 s; intervalSec = 5. Resolver picks the most recent
    // sample whose ts ≤ latestTs - 30 s.
    await store.upsert(
      task({
        conditions: [
          { kind: 'pct', baseline: 'trend', op: 'gte', thresholdPct: '5', window: 30 },
        ],
      }),
    );
    const port = new FakeQuotePort();
    // tick1 (T0)   : last=10.00 — only sample → no fire.
    port.responses.push(quote({ last: '10.00', ts: '2026-05-04T01:30:00Z' }));
    // tick2 (T0+30s): last=10.10 — sample at T0 is exactly window-old;
    //               baseline = 10.00, delta = +1 % < 5 → no fire.
    port.responses.push(quote({ last: '10.10', ts: '2026-05-04T01:30:30Z' }));
    // tick3 (T0+60s): last=10.62 — most recent sample with ts ≤ T0+30s
    //               is the T0+30s sample (older T0 sample is trimmed by
    //               the wall-clock buffer). baseline = 10.10,
    //               delta = (10.62-10.10)/10.10 ≈ 5.15 % ≥ 5 → fire.
    port.responses.push(quote({ last: '10.62', ts: '2026-05-04T01:31:00Z' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);
    await sched.tick(new Date(TICK_TIME.getTime() + 30_000));
    await sched.tick(new Date(TICK_TIME.getTime() + 60_000));

    expect(notifier.sent).toHaveLength(1);
    expect(store.get('a', '600000')?.hitCount).toBe(1);
  });

  it('treats quote with ts >30 min off server clock as no match', async () => {
    const dir = await tmpDir();
    const store = new WatchTaskStore(dir);
    await store.load();
    await store.upsert(task());
    const port = new FakeQuotePort();
    port.responses.push(quote({ ts: '2026-05-04T00:59:00Z' }));
    const notifier = new FakeNotifier();
    const sched = await newScheduler(store, port, notifier);

    await sched.tick(TICK_TIME);

    const after = store.get('a', '600000');
    expect(after?.hitCount).toBe(0);
    expect(after?.lastTickAt).toBe(TICK_TIME.toISOString());
    expect(after?.lastSampleAt).toBeNull();
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

    await sched.tick(new Date('2026-05-09T01:30:00Z'));

    expect(port.calls).toHaveLength(0);
  });
});
