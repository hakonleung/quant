/**
 * BatchSettler — registers batches, listens for terminal events on the
 * meta + kline queues, fires blacklist + dynamic-sectors recompute
 * when the batch is fully drained.
 */

import type { Sector } from '@quant/shared';

import { BatchSettler } from '../../../src/modules/orchestration/batch-settler.js';
import { InMemoryQueue } from '../../../src/modules/orchestration/domain/in-memory-queue.js';
import type {
  JobEnvelope,
  JobProcessor,
  KlineJob,
  MetaJob,
  ReQueue,
} from '../../../src/modules/orchestration/domain/types.js';

class FakeBlacklist {
  calls = 0;
  refresh(_traceId: string): Promise<{
    readonly codes: readonly string[];
    readonly asof: string;
    readonly universeSize: number;
    readonly computedAt: string;
  }> {
    this.calls += 1;
    return Promise.resolve({
      codes: [],
      asof: '2026-05-04',
      universeSize: 0,
      computedAt: '2026-05-04T00:00:00Z',
    });
  }
}

class FakeSectorsService {
  refreshed: string[] = [];
  shouldThrowFor = new Set<string>();
  refreshDynamic(_userId: string, id: string, _trace: string): Promise<unknown> {
    this.refreshed.push(id);
    if (this.shouldThrowFor.has(id)) return Promise.reject(new Error('boom'));
    return Promise.resolve({});
  }
}

class FakeSectorsStore {
  constructor(private readonly sectors: readonly Sector[]) {}
  list(): readonly Sector[] {
    return this.sectors;
  }
}

class FakeFundFlow {
  calls = 0;
  async syncAll(_trace?: string): Promise<{ ranked: number; written: number }> {
    this.calls += 1;
    return { ranked: 0, written: 0 };
  }
}

class NoopProcessor<T> implements JobProcessor<T> {
  async process(_e: JobEnvelope<T>, _q: ReQueue<T>): Promise<void> {
    // success path
  }
}

function dynamicSector(id: string, owner = 'admin'): Sector {
  return {
    id,
    name: id,
    kind: 'dynamic',
    codes: [],
    count: 0,
    meta: '',
    chgPct: null,
    createdBy: owner,
    published: false,
    screenPlan: {
      asof: '2026-05-04',
      expr: { kind: 'and', items: [] },
    } as unknown as Sector['screenPlan'],
  } as unknown as Sector;
}

describe('BatchSettler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function newQueues(): {
    metaQueue: InMemoryQueue<MetaJob>;
    klineQueue: InMemoryQueue<KlineJob>;
  } {
    const metaQueue = new InMemoryQueue<MetaJob>({ name: 'meta', concurrency: 4 });
    const klineQueue = new InMemoryQueue<KlineJob>({ name: 'kline', concurrency: 4 });
    metaQueue.setProcessor(new NoopProcessor<MetaJob>());
    klineQueue.setProcessor(new NoopProcessor<KlineJob>());
    return { metaQueue, klineQueue };
  }

  it('empty batch settles immediately', async () => {
    const { metaQueue, klineQueue } = newQueues();
    const blacklist = new FakeBlacklist();
    const sectorsService = new FakeSectorsService();
    const sectorsStore = new FakeSectorsStore([dynamicSector('s1')]);
    const settler = new BatchSettler(
      metaQueue,
      klineQueue,
      blacklist as never,
      sectorsService as never,
      sectorsStore as never,
      new FakeFundFlow() as never,
    );

    settler.register({ batchId: 'b0', metaCount: 0, klineCount: 0, traceId: 't0' });
    await jest.advanceTimersByTimeAsync(50);
    expect(blacklist.calls).toBe(1);
    expect(sectorsService.refreshed).toEqual(['s1']);
  });

  it('settles after every queued job emits a terminal event', async () => {
    const { metaQueue, klineQueue } = newQueues();
    const blacklist = new FakeBlacklist();
    const sectorsService = new FakeSectorsService();
    const sectorsStore = new FakeSectorsStore([dynamicSector('s1')]);
    const settler = new BatchSettler(
      metaQueue,
      klineQueue,
      blacklist as never,
      sectorsService as never,
      sectorsStore as never,
      new FakeFundFlow() as never,
    );

    const batchId = 'b1';
    settler.register({ batchId, metaCount: 1, klineCount: 1, traceId: 't1' });
    metaQueue.add(
      {
        kind: 'meta_pkg',
        code: '600000',
        needBasic: true,
        needFinancials: false,
        traceId: 't1',
        batchId,
      },
      { id: `meta:${batchId}:600000` },
    );
    klineQueue.add(
      { kind: 'kline_pkg', code: '600000', traceId: 't1', batchId },
      { id: `kline:${batchId}:600000` },
    );
    await jest.advanceTimersByTimeAsync(100);
    expect(blacklist.calls).toBe(1);
    expect(sectorsService.refreshed).toEqual(['s1']);
  });

  it('failures still count as terminal — settler does not hang', async () => {
    const { metaQueue, klineQueue } = newQueues();
    metaQueue.setProcessor({
      process(_e: JobEnvelope<MetaJob>, _q: ReQueue<MetaJob>): Promise<void> {
        return Promise.reject(new Error('forever'));
      },
    });
    // override with no retries → first failure is terminal.
    const metaWithRetry = new InMemoryQueue<MetaJob>({
      name: 'meta',
      concurrency: 4,
      maxRetry: 0,
    });
    metaWithRetry.setProcessor({
      process(_e: JobEnvelope<MetaJob>, _q: ReQueue<MetaJob>): Promise<void> {
        return Promise.reject(new Error('forever'));
      },
    });
    const blacklist = new FakeBlacklist();
    const sectorsService = new FakeSectorsService();
    const sectorsStore = new FakeSectorsStore([]);
    const settler = new BatchSettler(
      metaWithRetry,
      klineQueue,
      blacklist as never,
      sectorsService as never,
      sectorsStore as never,
      new FakeFundFlow() as never,
    );

    settler.register({ batchId: 'b2', metaCount: 1, klineCount: 0, traceId: 't2' });
    metaWithRetry.add(
      {
        kind: 'meta_pkg',
        code: '600519',
        needBasic: true,
        needFinancials: false,
        traceId: 't2',
        batchId: 'b2',
      },
      { id: 'meta:b2:600519' },
    );
    await jest.advanceTimersByTimeAsync(100);
    expect(blacklist.calls).toBe(1);
  });
});
