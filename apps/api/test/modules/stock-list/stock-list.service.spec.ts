import {
  DEFAULT_APPLIED_STOCK_LIST_COLUMNS,
  type KlineBar,
  type StockMetaDto,
  type StockSnapshotDto,
} from '@quant/shared';

import type { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';
import { StockListService } from '../../../src/modules/stock-list/stock-list.service.js';

const TRACE = 'tr';

const META_A: StockMetaDto = {
  code: '600519',
  name: '贵州茅台',
  name_pinyin: 'gzmt',
  industries: '酿酒',
  list_date: '2001-08-27',
  float_pct: '1',
  updated_at: '2026-05-15T00:00:00.000Z',
  total_share: null,
  float_share: null,
  net_assets: null,
  net_assets_period: null,
  quarterlies: [],
  financials_updated_at: null,
};

const META_B: StockMetaDto = { ...META_A, code: '000001', name: '平安银行', name_pinyin: 'payh' };

const SNAP_A: StockSnapshotDto = {
  meta: META_A,
  price: '1700.50',
  asof: '2026-05-15',
  derived: {
    mkt_cap: '2100000000000',
    float_mkt_cap: '2100000000000',
    pe_ttm: '30.5',
    pe_dynamic: null,
    pb: null,
    peg: null,
    gross_margin_ttm: null,
    wcmi: null,
  },
  returns: {
    ret_1d: '0.0123',
    ret_5d: '0.05',
    ret_10d: null,
    ret_20d: null,
    ret_90d: null,
    ret_250d: null,
  },
  dde: null,
};

const SNAP_B: StockSnapshotDto = {
  ...SNAP_A,
  meta: META_B,
  price: '12.30',
  derived: { ...SNAP_A.derived, mkt_cap: '300000000000' },
  returns: { ...SNAP_A.returns, ret_1d: '-0.005' },
};

function bar(date: string, close: number, turnover = 100, turnoverRate = 0.01): KlineBar {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    turnover,
    turnoverRate,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
  };
}

class FakeMeta {
  snapshotCalls = 0;
  metaCalls = 0;
  constructor(
    private readonly snaps: readonly StockSnapshotDto[],
    private readonly metas: readonly StockMetaDto[] = snaps.map((s) => s.meta),
  ) {}
  async listSnapshots(
    _codes: readonly string[],
    _trace: string,
  ): Promise<readonly StockSnapshotDto[]> {
    this.snapshotCalls += 1;
    return this.snaps;
  }
  async getBatch(_codes: readonly string[], _trace: string): Promise<readonly StockMetaDto[]> {
    this.metaCalls += 1;
    return this.metas;
  }
}

class FakeKline {
  bulkCalls = 0;
  constructor(private readonly bulk: Record<string, readonly KlineBar[]>) {}
  async lastNBulk(
    _codes: readonly string[],
    _n: number,
  ): Promise<Record<string, readonly KlineBar[]>> {
    this.bulkCalls += 1;
    return this.bulk;
  }
}

function svc(meta: FakeMeta, kline: FakeKline): StockListService {
  return new StockListService(
    meta as unknown as StockMetaService,
    kline as unknown as KlineReaderService,
  );
}

describe('StockListService.assembleRows', () => {
  it('returns the canonical column set + dynamic-sector default sort (wcmi desc)', async () => {
    const meta = new FakeMeta([SNAP_A, SNAP_B]);
    const kline = new FakeKline({
      '600519': [bar('2026-05-14', 1680, 100, 0.01), bar('2026-05-15', 1700, 200, 0.02)],
      '000001': [bar('2026-05-14', 12.4, 50, 0.005), bar('2026-05-15', 12.3, 60, 0.006)],
    });
    const out = await svc(meta, kline).assembleRows({
      kind: 'dynamic-sector',
      codes: ['600519', '000001'],
      traceId: TRACE,
    });

    expect(out.kind).toBe('dynamic-sector');
    expect(out.columns).toEqual([...DEFAULT_APPLIED_STOCK_LIST_COLUMNS]);
    expect(out.sort).toEqual({ key: 'wcmi', dir: 'desc' });
    // Both fixtures have null wcmi → stable sort preserves input code order.
    expect(out.rows.map((r) => r.code)).toEqual(['600519', '000001']);
    expect(out.rows[0]?.chgPct).toBeCloseTo(0.0123);
    expect(out.rows[0]?.turnoverRate).toBeCloseTo(0.02);
    expect(out.rows[0]?.turnover).toBe(200);
  });

  it('applies user-sector default sort (wcmi desc)', async () => {
    const meta = new FakeMeta([SNAP_A, SNAP_B]);
    const kline = new FakeKline({});
    const out = await svc(meta, kline).assembleRows({
      kind: 'user-sector',
      codes: ['600519', '000001'],
      traceId: TRACE,
    });
    expect(out.sort).toEqual({ key: 'wcmi', dir: 'desc' });
    // Both null wcmi → stable sort keeps the requested code order.
    expect(out.rows.map((r) => r.code)).toEqual(['600519', '000001']);
  });

  it('honors explicit columns + sort overrides', async () => {
    const meta = new FakeMeta([SNAP_A, SNAP_B]);
    const kline = new FakeKline({});
    const out = await svc(meta, kline).assembleRows({
      kind: 'screen',
      codes: ['000001', '600519'],
      columns: ['name', 'mktCap'],
      sort: { key: 'mktCap', dir: 'asc' },
      traceId: TRACE,
    });
    expect(out.columns).toEqual(['name', 'mktCap']);
    expect(out.rows.map((r) => r.code)).toEqual(['000001', '600519']);
  });

  it('skips kline fetch when no applied column needs it', async () => {
    const meta = new FakeMeta([SNAP_A]);
    const kline = new FakeKline({});
    await svc(meta, kline).assembleRows({
      kind: 'screen',
      codes: ['600519'],
      columns: ['name', 'price', 'mktCap'],
      traceId: TRACE,
    });
    expect(kline.bulkCalls).toBe(0);
    expect(meta.snapshotCalls).toBe(1);
  });

  it('skips snapshot fetch when columns are meta-only', async () => {
    const meta = new FakeMeta([SNAP_A]);
    const kline = new FakeKline({});
    await svc(meta, kline).assembleRows({
      kind: 'watch',
      codes: ['600519'],
      columns: ['name'],
      traceId: TRACE,
    });
    expect(meta.snapshotCalls).toBe(0);
    expect(meta.metaCalls).toBe(1);
  });

  it('treats nulls as "sort to bottom" regardless of direction', async () => {
    const partial: StockSnapshotDto = {
      ...SNAP_A,
      meta: { ...META_A, code: '000002', name: 'no-cap' },
      derived: { ...SNAP_A.derived, mkt_cap: null },
    };
    const meta = new FakeMeta([SNAP_A, partial]);
    const kline = new FakeKline({});
    const out = await svc(meta, kline).assembleRows({
      kind: 'screen',
      codes: ['600519', '000002'],
      columns: ['name', 'mktCap'],
      sort: { key: 'mktCap', dir: 'desc' },
      traceId: TRACE,
    });
    // Real value first, null last (bottom).
    expect(out.rows.map((r) => r.code)).toEqual(['600519', '000002']);
  });

  it('passes through evidence map verbatim', async () => {
    const meta = new FakeMeta([SNAP_A]);
    const kline = new FakeKline({});
    const out = await svc(meta, kline).assembleRows({
      kind: 'dynamic-sector',
      codes: ['600519'],
      columns: ['name', 'price'],
      evidenceByCode: { '600519': { vol_ratio: '+12.3%', streak: '5d' } },
      traceId: TRACE,
    });
    expect(out.rows[0]?.evidence).toEqual({ vol_ratio: '+12.3%', streak: '5d' });
  });

  it('expands empty codes to the universe (enumerated from snapshots + klineBulk)', async () => {
    const meta = new FakeMeta([SNAP_A, SNAP_B]);
    const kline = new FakeKline({
      '600519': [bar('2026-05-15', 1700)],
      '000001': [bar('2026-05-15', 12.3)],
      '000002': [bar('2026-05-15', 5)], // kline-only
    });
    const out = await svc(meta, kline).assembleRows({
      kind: 'user-sector',
      codes: [],
      traceId: TRACE,
    });
    expect(out.rows.map((r) => r.code).sort()).toEqual(['000001', '000002', '600519']);
  });

  it('handles a missing snapshot for a requested code (returns row with nulls)', async () => {
    const meta = new FakeMeta([SNAP_A]);
    const kline = new FakeKline({});
    const out = await svc(meta, kline).assembleRows({
      kind: 'screen',
      codes: ['600519', '000999'],
      columns: ['name', 'price'],
      traceId: TRACE,
    });
    const missing = out.rows.find((r) => r.code === '000999');
    expect(missing).toBeDefined();
    expect(missing?.name).toBeNull();
    expect(missing?.price).toBeNull();
  });
});
