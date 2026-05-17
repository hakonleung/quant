import type { StockSnapshotDto } from '@quant/shared';

import type { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';
import type { LocalStockMetaWriterService, StockMetricsRow } from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';
import type { StockMetricsComputeService } from '../../../src/modules/stock-meta/stock-metrics-compute.service.js';
import { StockMetricsBackfillService } from '../../../src/modules/stock-meta/stock-metrics-backfill.service.js';

function snap(code: string, asof: string | null): StockSnapshotDto {
  return {
    meta: {
      code,
      name: code,
      name_pinyin: code,
      industries: '银行',
      list_date: '2001-01-01',
      float_pct: '1',
      updated_at: '2026-05-01T00:00:00+00:00',
      total_share: null,
      float_share: null,
      net_assets: null,
      net_assets_period: null,
      quarterlies: [],
      financials_updated_at: null,
    },
    price: null,
    asof,
    derived: {
      mkt_cap: null,
      float_mkt_cap: null,
      pe_ttm: null,
      pe_dynamic: null,
      pb: null,
      peg: null,
      gross_margin_ttm: null,
      wcmi: null,
    },
    returns: {
      ret_1d: null,
      ret_5d: null,
      ret_10d: null,
      ret_20d: null,
      ret_90d: null,
      ret_250d: null,
    },
    dde: null,
  };
}

function emptyMetricsRow(code: string, asof: string): StockMetricsRow {
  return {
    code,
    asof,
    metricsPrice: null,
    ret_1d: null,
    ret_5d: null,
    ret_10d: null,
    ret_20d: null,
    ret_90d: null,
    ret_250d: null,
    mkt_cap: null,
    float_mkt_cap: null,
    pe_ttm: null,
    pe_dynamic: null,
    pb: null,
    peg: null,
    gross_margin_ttm: null,
    wcmi: null,
  };
}

function makeFakes(opts: {
  readonly snapshots: readonly StockSnapshotDto[];
  readonly watermarks: ReadonlyMap<string, Date>;
  readonly computeError?: string;
}): {
  readonly service: StockMetricsBackfillService;
  readonly upserted: StockMetricsRow[][];
  readonly computedCodes: string[];
} {
  const upserted: StockMetricsRow[][] = [];
  const computedCodes: string[] = [];
  const meta = { snapshotAll: async () => opts.snapshots } as unknown as StockMetaService;
  const kline = {
    lastTradeDates: async (codes: readonly string[]) => {
      const filtered = new Map<string, Date>();
      for (const c of codes) {
        const ts = opts.watermarks.get(c);
        if (ts !== undefined) filtered.set(c, ts);
      }
      return filtered;
    },
  } as unknown as KlineReaderService;
  const compute = {
    computeForCode: async (code: string) => {
      computedCodes.push(code);
      if (opts.computeError !== undefined && code === opts.computeError) {
        throw new Error('boom');
      }
      const watermark = opts.watermarks.get(code);
      if (watermark === undefined) return null;
      return emptyMetricsRow(code, watermark.toISOString().slice(0, 10));
    },
  } as unknown as StockMetricsComputeService;
  const writer = {
    upsertMetrics: async (rows: readonly StockMetricsRow[]) => {
      upserted.push([...rows]);
    },
  } as unknown as LocalStockMetaWriterService;
  const service = new StockMetricsBackfillService(meta, kline, compute, writer);
  return { service, upserted, computedCodes };
}

describe('StockMetricsBackfillService.run', () => {
  it('projects codes whose snapshot.asof is null but kline has bars', async () => {
    const { service, upserted, computedCodes } = makeFakes({
      snapshots: [snap('000001', null)],
      watermarks: new Map([['000001', new Date('2026-05-15T00:00:00Z')]]),
    });

    const result = await service.run('tr-1');

    expect(result).toEqual({ scanned: 1, projected: 1 });
    expect(computedCodes).toEqual(['000001']);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.[0]?.code).toBe('000001');
  });

  it('projects codes whose snapshot.asof trails the kline watermark', async () => {
    const { service, upserted } = makeFakes({
      snapshots: [snap('600519', '2026-05-10')],
      watermarks: new Map([['600519', new Date('2026-05-15T00:00:00Z')]]),
    });

    const result = await service.run('tr-2');

    expect(result.projected).toBe(1);
    expect(upserted[0]?.[0]?.asof).toBe('2026-05-15');
  });

  it('skips codes already in sync', async () => {
    const { service, upserted, computedCodes } = makeFakes({
      snapshots: [snap('600519', '2026-05-15')],
      watermarks: new Map([['600519', new Date('2026-05-15T00:00:00Z')]]),
    });

    const result = await service.run('tr-3');

    expect(result).toEqual({ scanned: 0, projected: 0 });
    expect(computedCodes).toEqual([]);
    expect(upserted).toEqual([]);
  });

  it('skips codes that have no kline at all', async () => {
    const { service, upserted, computedCodes } = makeFakes({
      snapshots: [snap('999999', null)],
      watermarks: new Map(),
    });

    const result = await service.run('tr-4');

    expect(result).toEqual({ scanned: 0, projected: 0 });
    expect(computedCodes).toEqual([]);
    expect(upserted).toEqual([]);
  });

  it('isolates a single compute failure without aborting the batch', async () => {
    const { service, upserted } = makeFakes({
      snapshots: [snap('000001', null), snap('600519', null)],
      watermarks: new Map([
        ['000001', new Date('2026-05-15T00:00:00Z')],
        ['600519', new Date('2026-05-15T00:00:00Z')],
      ]),
      computeError: '000001',
    });

    const result = await service.run('tr-5');

    expect(result).toEqual({ scanned: 2, projected: 1 });
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.[0]?.code).toBe('600519');
  });

  it('no-ops when the universe is empty', async () => {
    const { service, upserted, computedCodes } = makeFakes({
      snapshots: [],
      watermarks: new Map(),
    });

    const result = await service.run('tr-6');

    expect(result).toEqual({ scanned: 0, projected: 0 });
    expect(computedCodes).toEqual([]);
    expect(upserted).toEqual([]);
  });
});

describe('StockMetricsBackfillService.runAll', () => {
  it('projects every code with kline, regardless of snapshot.asof', async () => {
    const { service, upserted, computedCodes } = makeFakes({
      // 600519 already in sync, 000001 trailing — both should still be projected.
      snapshots: [snap('600519', '2026-05-15'), snap('000001', '2026-05-10')],
      watermarks: new Map([
        ['600519', new Date('2026-05-15T00:00:00Z')],
        ['000001', new Date('2026-05-15T00:00:00Z')],
      ]),
    });

    const result = await service.runAll('full-1');

    expect(result).toEqual({ scanned: 2, projected: 2 });
    expect(computedCodes.sort()).toEqual(['000001', '600519']);
    expect(upserted).toHaveLength(1);
  });

  it('skips codes that have no kline rows at all', async () => {
    const { service, computedCodes } = makeFakes({
      snapshots: [snap('600519', '2026-05-15'), snap('999999', null)],
      watermarks: new Map([['600519', new Date('2026-05-15T00:00:00Z')]]),
    });

    const result = await service.runAll('full-2');

    expect(result.scanned).toBe(1);
    expect(computedCodes).toEqual(['600519']);
  });
});
