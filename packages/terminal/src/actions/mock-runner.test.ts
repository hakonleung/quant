import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMockState,
  MockActionRunner,
} from '../actions/mock-runner.js';
import {
  analyzeOneAction,
  sectorListAction,
  sectorRemoveAction,
  sectorUpsertAction,
  stockInfoAction,
  stockListAction,
  watchListAction,
  watchUpsertAction,
} from '../actions/registry.js';
import { QuantError } from '@quant/shared';

const noSignal = new AbortController().signal;

describe('MockActionRunner', () => {
  let runner: MockActionRunner;

  beforeEach(() => {
    _resetMockState();
    runner = new MockActionRunner();
  });

  it('stock.list returns the universe (golden) and is cached on second call', async () => {
    const r1 = await runner.run(stockListAction, {}, { signal: noSignal });
    expect(r1.cached).toBe(false);
    expect(r1.data.length).toBeGreaterThan(0);
    const r2 = await runner.run(stockListAction, {}, { signal: noSignal });
    expect(r2.cached).toBe(true);
  });

  it('stock.info throws QuantError on missing code', async () => {
    await expect(
      runner.run(stockInfoAction, { code: '999999' }, { signal: noSignal }),
    ).rejects.toBeInstanceOf(QuantError);
  });

  it('forceFresh bypasses cache', async () => {
    await runner.run(stockListAction, {}, { signal: noSignal });
    const r = await runner.run(stockListAction, {}, { signal: noSignal, forceFresh: true });
    expect(r.cached).toBe(false);
  });

  it('write action invalidates the corresponding read cache', async () => {
    await runner.run(sectorListAction, {}, { signal: noSignal });
    const sector = {
      id: 'wine',
      name: 'wine',
      kind: 'user' as const,
      count: 1,
      meta: '',
      chgPct: null,
      codes: ['600519'],
    };
    await runner.run(sectorUpsertAction, { sector }, { signal: noSignal });
    const after = await runner.run(sectorListAction, {}, { signal: noSignal });
    expect(after.cached).toBe(false);
    expect(after.data.find((s) => s.id === 'wine')).toBeDefined();
  });

  it('analyze.one returns a Sentiment', async () => {
    const r = await runner.run(analyzeOneAction, { code: '600519' }, { signal: noSignal });
    expect(r.data.code).toBe('600519');
    expect(typeof r.data.score).toBe('number');
  });

  it('sector.remove unknown id throws', async () => {
    await expect(
      runner.run(sectorRemoveAction, { idOrName: 'nope' }, { signal: noSignal }),
    ).rejects.toBeInstanceOf(QuantError);
  });

  it('watch upsert + list round-trips', async () => {
    await runner.run(
      watchUpsertAction,
      {
        task: {
          market: 'a',
          code: '600519',
          name: '贵州茅台',
          conditions: [
            { kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '3' },
          ],
          intervalSec: 60,
          pushIntervalSec: 300,
          enabled: true,
          hitCount: 0,
        },
      },
      { signal: noSignal },
    );
    const r = await runner.run(watchListAction, {}, { signal: noSignal });
    expect(r.data.length).toBe(1);
  });

  it('aborts when signal already aborted (boundary)', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runner.run(stockListAction, {}, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(QuantError);
  });
});
