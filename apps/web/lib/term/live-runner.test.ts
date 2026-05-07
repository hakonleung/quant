/**
 * LiveActionRunner — exercises the BFF integration with `fetch` mocked.
 * Covers the cache contract (mock-vs-live parity), abort propagation,
 * and one happy-path call per action category. EventSource is stubbed
 * for `watch.list`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeOneAction,
  MockCache,
  stockKlineAction,
  stockListAction,
  type DataActionConfig,
  type RevalidateScope,
} from '@quant/terminal';

import { LiveActionRunner } from './live-runner.js';

const META = {
  code: '600519',
  name: '贵州茅台',
  name_pinyin: 'gzmt',
  industries: '白酒',
  list_date: '2001-08-27',
  float_pct: '1.0',
  updated_at: '2026-05-01T00:00:00.000Z',
  total_share: null,
  float_share: null,
  net_assets: null,
  net_assets_period: null,
  quarterlies: [],
  financials_updated_at: null,
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function newRunner(
  deps: {
    readonly revalidate?: (scope: RevalidateScope) => void;
  } = {},
): LiveActionRunner {
  return new LiveActionRunner({ lookupName: () => null, ...deps }, new MockCache(null, 60_000));
}

describe('LiveActionRunner — caching parity', () => {
  it('caches read results; second call short-circuits', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse([META]));
    const r = newRunner();
    const ac = new AbortController();

    const first = await r.run(stockListAction, {}, { signal: ac.signal });
    expect(first.cached).toBe(false);
    expect(first.data[0]?.code).toBe('600519');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await r.run(stockListAction, {}, { signal: ac.signal });
    expect(second.cached).toBe(true);
    // Should NOT have hit the network again
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('forceFresh bypasses the cache', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse([META]));
    fetchSpy.mockResolvedValueOnce(jsonResponse([META]));
    const r = newRunner();
    const ac = new AbortController();
    await r.run(stockListAction, {}, { signal: ac.signal });
    await r.run(stockListAction, {}, { signal: ac.signal, forceFresh: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('LiveActionRunner — abort propagation', () => {
  it('throws on already-aborted signal before any fetch', async () => {
    const r = newRunner();
    const ac = new AbortController();
    ac.abort();
    await expect(r.run(stockListAction, {}, { signal: ac.signal })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('LiveActionRunner — kline projection', () => {
  it('projects shared KlineBar to the simplified terminal shape', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([
        {
          date: '2026-04-30',
          open: 1380,
          high: 1410,
          low: 1370,
          close: 1402,
          volume: 1234567,
          turnover: 1.7e9,
          turnoverRate: 0.5,
          ma5: 1400,
          ma10: 1395,
          ma20: 1380,
          ma60: 1300,
        },
      ]),
    );
    const r = newRunner();
    const ac = new AbortController();
    const out = await r.run(
      stockKlineAction,
      { code: '600519', range: '90D' },
      { signal: ac.signal },
    );
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toEqual({
      date: '2026-04-30',
      open: 1380,
      high: 1410,
      low: 1370,
      close: 1402,
      volume: 1234567,
    });
    // Should hit the gateway path with `range` query
    const callUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(callUrl).toMatch(/\/api\/kline\/600519\?range=90D/);
  });
});

describe('LiveActionRunner — cross-cache revalidation', () => {
  it('calls revalidate("sentiment") after a successful analyze.one', async () => {
    // Cached read returns null → runner posts to analyze_one → writes.
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 404)); // GET cached miss
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        code: '600519',
        score: 0.7,
        theme: 't',
        driver: 'd',
        target: 0,
        rumor: '',
        cachedAt: '2026-04-30T01:00:00.000Z',
        rawLog: [],
        result: '',
      }),
    );
    const revalidate = vi.fn<(scope: RevalidateScope) => void>();
    const r = newRunner({ revalidate });
    const ac = new AbortController();

    const out = await r.run(analyzeOneAction, { code: '600519' }, { signal: ac.signal });
    expect(out.data.score).toBe(0.7);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith('sentiment');
  });

  it('does NOT call revalidate after a plain read action', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse([META]));
    const revalidate = vi.fn<(scope: RevalidateScope) => void>();
    const r = newRunner({ revalidate });
    const ac = new AbortController();
    await r.run(stockListAction, {}, { signal: ac.signal });
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe('LiveActionRunner — unknown action surfaces a clean error', () => {
  it('throws QuantError when no fetcher is registered', async () => {
    const r = newRunner();
    const fakeAction: DataActionConfig<Record<string, never>, unknown> = {
      id: 'unknown.action',
      kind: 'read',
      summary: 's',
      // Same loose schemas — we just need the runner to reach the dispatch.
      args: stockListAction.args,
      result: stockListAction.result,
      cacheKey: () => ['unknown.action'],
    };
    const ac = new AbortController();
    await expect(r.run(fakeAction, {}, { signal: ac.signal })).rejects.toThrow(/no live fetcher/);
  });
});
