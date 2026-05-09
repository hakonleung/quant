/**
 * Mock action runner. Reads from `mock-fixtures.ts`, writes to in-memory
 * mutable state, caches reads via `MockCache`. No real network calls;
 * shape-compatible with `LiveActionRunner` (M2).
 */

import { QuantError } from '@quant/shared';
import { MockCache } from './mock-cache.js';
import {
  analyzeManyAction,
  analyzeOneAction,
  analyzeTaAction,
  screenNlAction,
  sectorListAction,
  sectorRefreshDynamicAction,
  sectorRemoveAction,
  sectorShowAction,
  sectorUpsertAction,
  stockInfoAction,
  stockKlineAction,
  stockListAction,
  stockSnapshotsAction,
  userMeAction,
  watchListAction,
  watchRemoveAction,
  watchUpsertAction,
} from './registry.js';
import {
  _resetFixtures,
  fixtureFindSector,
  fixtureKline,
  fixtureMarketSentiment,
  fixtureRemoveSector,
  fixtureRemoveWatch,
  fixtureScreenResult,
  fixtureSectors,
  fixtureSentiment,
  fixtureSnapshots,
  fixtureTaAnalysis,
  fixtureStockMeta,
  fixtureStockMetas,
  fixtureUpsertSector,
  fixtureUpsertWatch,
  fixtureWatch,
} from './mock-fixtures.js';
import type { DataActionConfig, DataActionRunner, RunOpts, RunOutcome } from './types.js';

type Fetcher = (args: never) => unknown | Promise<unknown>;
const fetchers: Record<string, Fetcher> = {
  [stockListAction.id]: () => fixtureStockMetas(),
  [stockInfoAction.id]: ({ code }: { code: string }) => {
    const meta = fixtureStockMeta(code);
    if (meta === null) {
      throw new QuantError('STOCK_NOT_FOUND', `stock ${code} not found`);
    }
    return meta;
  },
  [stockKlineAction.id]: ({ code, range }: { code: string; range: '30D' | '90D' | '250D' }) =>
    fixtureKline(code, range),
  [stockSnapshotsAction.id]: ({ codes }: { codes: readonly string[] }) => fixtureSnapshots(codes),
  [sectorListAction.id]: () => fixtureSectors(),
  [sectorShowAction.id]: ({ idOrName }: { idOrName: string }) => {
    const s = fixtureFindSector(idOrName);
    if (s === null) throw new QuantError('NOT_FOUND', `sector ${idOrName} not found`);
    return s;
  },
  [sectorUpsertAction.id]: ({ sector }: { sector: Parameters<typeof fixtureUpsertSector>[0] }) =>
    fixtureUpsertSector(sector),
  [sectorRemoveAction.id]: ({ idOrName }: { idOrName: string }) => {
    if (!fixtureRemoveSector(idOrName)) {
      throw new QuantError('NOT_FOUND', `sector ${idOrName} not found`);
    }
    return { idOrName };
  },
  [sectorRefreshDynamicAction.id]: ({ idOrName }: { idOrName: string }) => {
    const cur = fixtureFindSector(idOrName);
    if (cur === null) throw new QuantError('NOT_FOUND', `sector ${idOrName} not found`);
    if (cur.kind !== 'dynamic') {
      throw new QuantError('INVALID_ARGUMENT', `sector ${idOrName} is not dynamic`);
    }
    // Pretend the result is similar but slightly different.
    const refreshed = { ...cur, count: Math.max(1, cur.count - 1), chgPct: 1.4 };
    return fixtureUpsertSector(refreshed);
  },
  [analyzeOneAction.id]: ({ code }: { code: string }) => fixtureSentiment(code),
  [analyzeManyAction.id]: ({ codes }: { codes: readonly string[] }) =>
    fixtureMarketSentiment(codes),
  [analyzeTaAction.id]: ({ code }: { code: string }) => fixtureTaAnalysis(code),
  [screenNlAction.id]: ({ nl }: { nl: string }) => fixtureScreenResult(nl),
  [watchListAction.id]: () => fixtureWatch(),
  [watchUpsertAction.id]: ({ task }: { task: Parameters<typeof fixtureUpsertWatch>[0] }) =>
    fixtureUpsertWatch(task),
  [watchRemoveAction.id]: ({ market, code }: { market: string; code: string }) => {
    if (!fixtureRemoveWatch(market, code)) {
      throw new QuantError('WATCH_CODE_NOT_FOUND', `watch ${market}/${code} not found`);
    }
    return { market, code };
  },
  [userMeAction.id]: () => ({
    userId: 'admin',
    displayName: 'admin',
    role: 'admin' as const,
    source: 'env' as const,
    imBootstrap: false,
  }),
};

export interface MockRunnerOptions {
  /** Min/max latency simulated for cache misses (paid actions clamp to 600..1500). */
  readonly latencyRange?: readonly [number, number];
  readonly cache?: MockCache;
}

export class MockActionRunner implements DataActionRunner {
  readonly id = 'mock' as const;
  private readonly cache: MockCache;
  private readonly latencyRange: readonly [number, number];

  constructor(opts: MockRunnerOptions = {}) {
    this.cache = opts.cache ?? new MockCache();
    this.latencyRange = opts.latencyRange ?? [0, 0];
  }

  async run<A, R>(cfg: DataActionConfig<A, R>, args: A, opts: RunOpts): Promise<RunOutcome<R>> {
    if (opts.signal.aborted) {
      throw new QuantError('INTERNAL', 'aborted');
    }
    const validated = cfg.args.parse(args) as A;
    const fetcher = fetchers[cfg.id];
    if (fetcher === undefined) {
      throw new QuantError('INTERNAL', `mock fetcher missing for action ${cfg.id}`);
    }

    if (cfg.kind === 'read' && cfg.cacheKey !== undefined && opts.forceFresh !== true) {
      const cached = this.cache.get(cfg.cacheKey(validated));
      if (cached !== undefined) {
        return { data: cached as R, cached: true };
      }
    }

    await this.simulateLatency(cfg.kind);
    const result = await (fetcher as (a: unknown) => unknown | Promise<unknown>)(validated);
    const parsed = cfg.result.parse(result) as R;

    if (cfg.kind === 'read' && cfg.cacheKey !== undefined) {
      this.cache.set(cfg.cacheKey(validated), parsed);
    }
    if (cfg.kind !== 'read' && cfg.invalidates !== undefined) {
      for (const prefix of cfg.invalidates(validated)) {
        this.cache.invalidate(prefix);
      }
    }

    return { data: parsed, cached: false };
  }

  invalidate(prefix: readonly (string | number | boolean)[]): void {
    this.cache.invalidate(prefix);
  }

  stats(): { entries: number; hits: number; misses: number } {
    return this.cache.stats();
  }

  private async simulateLatency(kind: 'read' | 'write' | 'paid'): Promise<void> {
    const [lo, hi] = this.latencyRange;
    const base = lo + Math.random() * Math.max(0, hi - lo);
    const ms = kind === 'paid' ? Math.max(base, 0) : base;
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

export function _resetMockState(): void {
  _resetFixtures();
}
