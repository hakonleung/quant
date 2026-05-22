/**
 * Integration test for ``LocalStockMetaWriterService``.
 *
 * Seeds a real ``stock_metas.parquet`` (via DuckDB) with two meta
 * rows whose metrics columns are still all-null, runs an upsert for
 * one of the codes, and verifies via ``LocalStockMetaAdapter`` that
 * (a) the targeted row's metrics block is populated, (b) the
 * non-targeted row is untouched, and (c) preserved meta columns on
 * the targeted row (name / industries / list_date) survive the
 * rewrite.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { StockMetaDto } from '@quant/shared';

import { FrozenClock } from '../../../src/common/clock.js';
import { LocalStockMetaAdapter } from '../../../src/modules/stock-meta/local-stock-meta.adapter.js';
import {
  LocalStockMetaWriterService,
  type StockFundFlowRow,
  type StockMetricsRow,
} from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';

const FROZEN = new Date('2026-05-16T08:00:00Z');

const META_COLUMNS: readonly { readonly name: string; readonly type: string }[] = [
  { name: 'code', type: 'VARCHAR' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'name_pinyin', type: 'VARCHAR' },
  { name: 'industries', type: 'VARCHAR' },
  { name: 'list_date', type: 'DATE' },
  { name: 'float_pct', type: 'VARCHAR' },
  { name: 'updated_at', type: 'TIMESTAMP' },
  { name: 'total_share', type: 'VARCHAR' },
  { name: 'float_share', type: 'VARCHAR' },
  { name: 'net_assets', type: 'VARCHAR' },
  { name: 'net_assets_period', type: 'DATE' },
  { name: 'quarterlies_json', type: 'VARCHAR' },
  { name: 'financials_updated_at', type: 'TIMESTAMP' },
  { name: 'metrics_asof', type: 'DATE' },
  { name: 'metrics_updated_at', type: 'TIMESTAMP' },
  { name: 'metrics_price', type: 'VARCHAR' },
  { name: 'ret_1d', type: 'VARCHAR' },
  { name: 'ret_5d', type: 'VARCHAR' },
  { name: 'ret_10d', type: 'VARCHAR' },
  { name: 'ret_20d', type: 'VARCHAR' },
  { name: 'ret_90d', type: 'VARCHAR' },
  { name: 'ret_250d', type: 'VARCHAR' },
  { name: 'mkt_cap', type: 'VARCHAR' },
  { name: 'float_mkt_cap', type: 'VARCHAR' },
  { name: 'pe_ttm', type: 'VARCHAR' },
  { name: 'pe_dynamic', type: 'VARCHAR' },
  { name: 'pb', type: 'VARCHAR' },
  { name: 'peg', type: 'VARCHAR' },
  { name: 'gross_margin_ttm', type: 'VARCHAR' },
  { name: 'dde_main_net_inflow_3d', type: 'VARCHAR' },
  { name: 'dde_main_net_inflow_5d', type: 'VARCHAR' },
  { name: 'dde_main_net_inflow_10d', type: 'VARCHAR' },
  { name: 'dde_main_net_inflow_20d', type: 'VARCHAR' },
  { name: 'dde_main_inflow_ratio_3d', type: 'VARCHAR' },
  { name: 'dde_main_inflow_ratio_5d', type: 'VARCHAR' },
  { name: 'dde_main_inflow_ratio_10d', type: 'VARCHAR' },
  { name: 'dde_main_inflow_ratio_20d', type: 'VARCHAR' },
  { name: 'dde_updated_at', type: 'TIMESTAMP' },
];

function buildRowValues(seed: Readonly<Record<string, string>>): string {
  return META_COLUMNS.map((c) => {
    const value = seed[c.name];
    if (value === undefined) return 'NULL';
    if (c.type === 'DATE') return `DATE '${value}'`;
    if (c.type === 'TIMESTAMP') return `TIMESTAMP '${value}'`;
    return `'${value.replace(/'/g, "''")}'`;
  }).join(', ');
}

async function seedParquet(dataRoot: string): Promise<void> {
  const path = join(dataRoot, 'stock_metas.parquet');
  const inst = await DuckDBInstance.create(':memory:');
  const conn: DuckDBConnection = await inst.connect();
  const colSql = META_COLUMNS.map((c) => `${c.name} ${c.type}`).join(', ');
  await conn.run(`CREATE TABLE stock_metas (${colSql});`);
  const rows = [
    {
      code: '600519',
      name: '贵州茅台',
      name_pinyin: 'GZMT',
      industries: '食品饮料,白酒',
      list_date: '2001-08-27',
      float_pct: '1',
      updated_at: '2026-05-01 00:00:00',
    },
    {
      code: '000001',
      name: '平安银行',
      name_pinyin: 'PAYH',
      industries: '银行',
      list_date: '1991-04-03',
      float_pct: '0.95',
      updated_at: '2026-05-01 00:00:00',
    },
  ];
  const valuesSql = rows.map((r) => `(${buildRowValues(r)})`).join(',\n      ');
  await conn.run(`INSERT INTO stock_metas VALUES\n      ${valuesSql};`);
  await conn.run(`COPY stock_metas TO '${path}' (FORMAT PARQUET);`);
}

describe('LocalStockMetaWriterService', () => {
  let dataRoot: string;
  let writer: LocalStockMetaWriterService;
  let adapter: LocalStockMetaAdapter;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'meta-writer-'));
    await seedParquet(dataRoot);
    adapter = new LocalStockMetaAdapter(dataRoot);
    writer = new LocalStockMetaWriterService(dataRoot, new FrozenClock(FROZEN), adapter);
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  const sampleRow = (code: string): StockMetricsRow => ({
    code,
    asof: '2026-05-15',
    metricsPrice: '1700.5',
    ret_1d: '0.01',
    ret_5d: '0.05',
    ret_10d: '0.10',
    ret_20d: '0.20',
    ret_90d: '0.30',
    ret_250d: '0.40',
    mkt_cap: '2133727500000',
    float_mkt_cap: '2133727500000',
    pe_ttm: '24.5',
    pe_dynamic: '23.1',
    pb: '7.8',
    peg: '0.6',
    gross_margin_ttm: '0.916',
    wcmi: '0.1',
    wcmi_rhythm: null,
    wcmi_ma_support: null,
    wcmi_up_wave: null,
    wcmi_yang_dom: null,
    wcmi_shadow_clean: null,
    wcmi_stage_gain: null,
    wcmi_crash_avoid: null,
  });

  it('populates metrics columns for the targeted code', async () => {
    await writer.upsertMetrics([sampleRow('600519')]);
    const snap = await adapter.listSnapshots(['600519']);
    expect(snap).toHaveLength(1);
    const row = snap[0];
    expect(row?.price).toBe('1700.5');
    expect(row?.asof).toBe('2026-05-15');
    expect(row?.derived.mkt_cap).toBe('2133727500000');
    expect(row?.derived.pe_ttm).toBe('24.5');
    expect(row?.returns.ret_5d).toBe('0.05');
    expect(row?.returns.ret_250d).toBe('0.40');
  });

  it('leaves non-targeted rows untouched', async () => {
    await writer.upsertMetrics([sampleRow('600519')]);
    const snap = await adapter.listSnapshots(['000001']);
    expect(snap).toHaveLength(1);
    const row = snap[0];
    expect(row?.price).toBeNull();
    expect(row?.asof).toBeNull();
    expect(row?.derived.mkt_cap).toBeNull();
  });

  it('preserves non-metric meta columns on the targeted row', async () => {
    await writer.upsertMetrics([sampleRow('600519')]);
    const meta = await adapter.getOne('600519');
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe('贵州茅台');
    expect(meta?.industries).toBe('食品饮料,白酒');
    expect(meta?.list_date).toBe('2001-08-27');
    expect(meta?.float_pct).toBe('1');
  });

  it('is a no-op when given an empty batch', async () => {
    await writer.upsertMetrics([]);
    const snap = await adapter.listSnapshots(['600519']);
    expect(snap[0]?.price).toBeNull();
  });

  it('silently drops rows whose code is absent from the meta file', async () => {
    await writer.upsertMetrics([sampleRow('999999'), sampleRow('600519')]);
    const snap = await adapter.listSnapshots(['600519']);
    expect(snap[0]?.price).toBe('1700.5');
    // 999999 was never in the seed → still not in the universe.
    const missing = await adapter.getOne('999999');
    expect(missing).toBeNull();
  });

  describe('upsertMetas', () => {
    const sampleMeta = (overrides: Partial<StockMetaDto> = {}): StockMetaDto => ({
      code: '600519',
      name: '贵州茅台 v2',
      name_pinyin: 'GZMT',
      industries: '食品饮料,白酒,新主线',
      list_date: '2001-08-27',
      float_pct: '0.95',
      updated_at: '2026-05-16T00:00:00+00:00',
      total_share: '1255980000',
      float_share: '1193180000',
      net_assets: '230000000000',
      net_assets_period: '2026-03-31',
      quarterlies: [
        {
          period: '2026-03-31',
          revenue: '50000000000',
          operating_cost: '10000000000',
          net_profit: '25000000000',
          net_profit_excl_nr: '24500000000',
        },
      ],
      financials_updated_at: '2026-05-15T08:00:00+00:00',
      ...overrides,
    });

    it('replaces non-metric columns on an existing code', async () => {
      await writer.upsertMetas([sampleMeta()]);
      const meta = await adapter.getOne('600519');
      expect(meta).not.toBeNull();
      expect(meta?.name).toBe('贵州茅台 v2');
      expect(meta?.industries).toBe('食品饮料,白酒,新主线');
      expect(meta?.total_share).toBe('1255980000');
      expect(meta?.financials_updated_at).toBe('2026-05-15T08:00:00.000+00:00');
      expect(meta?.quarterlies).toHaveLength(1);
      expect(meta?.quarterlies[0]?.revenue).toBe('50000000000');
    });

    it('preserves existing metrics columns on an existing code', async () => {
      // First populate metrics, then upsert meta — metrics must survive.
      await writer.upsertMetrics([sampleRow('600519')]);
      await writer.upsertMetas([sampleMeta()]);
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap[0]?.price).toBe('1700.5');
      expect(snap[0]?.derived.mkt_cap).toBe('2133727500000');
      expect(snap[0]?.returns.ret_5d).toBe('0.05');
    });

    it('inserts a brand new code with null metric columns', async () => {
      const fresh = sampleMeta({ code: '300750', name: '宁德时代', name_pinyin: 'NDSD' });
      await writer.upsertMetas([fresh]);
      const meta = await adapter.getOne('300750');
      expect(meta?.name).toBe('宁德时代');
      const snap = await adapter.listSnapshots(['300750']);
      expect(snap).toHaveLength(1);
      expect(snap[0]?.price).toBeNull();
      expect(snap[0]?.derived.mkt_cap).toBeNull();
    });

    it('leaves unrelated rows untouched', async () => {
      await writer.upsertMetas([sampleMeta()]);
      const other = await adapter.getOne('000001');
      expect(other?.name).toBe('平安银行');
      expect(other?.industries).toBe('银行');
    });

    it('is a no-op when given an empty batch', async () => {
      await writer.upsertMetas([]);
      const meta = await adapter.getOne('600519');
      // Seed name (unchanged) — no rewrite happened.
      expect(meta?.name).toBe('贵州茅台');
    });
  });

  describe('upsertFundFlow', () => {
    const ddeRow = (overrides: Partial<StockFundFlowRow> = {}): StockFundFlowRow => ({
      code: '600519',
      dde_main_net_inflow_3d: '300000000',
      dde_main_net_inflow_5d: '500000000',
      dde_main_net_inflow_10d: '900000000',
      dde_main_net_inflow_20d: null,
      dde_main_inflow_ratio_3d: '0.1',
      dde_main_inflow_ratio_5d: '0.0833',
      dde_main_inflow_ratio_10d: '0.05',
      dde_main_inflow_ratio_20d: null,
      ...overrides,
    });

    it('populates the DDE block for the targeted code', async () => {
      await writer.upsertFundFlow([ddeRow()]);
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap).toHaveLength(1);
      const dde = snap[0]?.dde;
      expect(dde).not.toBeNull();
      expect(dde?.main_net_inflow_3d).toBe('300000000');
      expect(dde?.main_inflow_ratio_5d).toBe('0.0833');
      expect(dde?.main_net_inflow_20d).toBeNull();
      expect(dde?.main_inflow_ratio_20d).toBeNull();
    });

    it('leaves non-targeted rows with a null DDE block', async () => {
      await writer.upsertFundFlow([ddeRow()]);
      const snap = await adapter.listSnapshots(['000001']);
      expect(snap[0]?.dde).toBeNull();
    });

    it('preserves metrics + meta columns when upserting fund flow', async () => {
      await writer.upsertMetrics([sampleRow('600519')]);
      await writer.upsertFundFlow([ddeRow()]);
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap[0]?.price).toBe('1700.5');
      expect(snap[0]?.derived.mkt_cap).toBe('2133727500000');
      expect(snap[0]?.returns.ret_5d).toBe('0.05');
      expect(snap[0]?.dde?.main_net_inflow_3d).toBe('300000000');
      const meta = await adapter.getOne('600519');
      expect(meta?.name).toBe('贵州茅台');
      expect(meta?.industries).toBe('食品饮料,白酒');
    });

    it('subsequent metrics upsert preserves the DDE block', async () => {
      await writer.upsertFundFlow([ddeRow()]);
      await writer.upsertMetrics([sampleRow('600519')]);
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap[0]?.dde?.main_net_inflow_3d).toBe('300000000');
      expect(snap[0]?.price).toBe('1700.5');
    });

    it('subsequent meta upsert preserves the DDE block', async () => {
      await writer.upsertFundFlow([ddeRow()]);
      await writer.upsertMetas([
        {
          code: '600519',
          name: '贵州茅台 v2',
          name_pinyin: 'GZMT',
          industries: '食品饮料,白酒,新主线',
          list_date: '2001-08-27',
          float_pct: '0.95',
          updated_at: '2026-05-16T00:00:00+00:00',
          total_share: '1255980000',
          float_share: '1193180000',
          net_assets: '230000000000',
          net_assets_period: '2026-03-31',
          quarterlies: [],
          financials_updated_at: '2026-05-15T08:00:00+00:00',
        },
      ]);
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap[0]?.dde?.main_inflow_ratio_3d).toBe('0.1');
      expect(snap[0]?.meta.name).toBe('贵州茅台 v2');
    });

    it('handles negative inflow + negative ratio', async () => {
      await writer.upsertFundFlow([
        ddeRow({
          dde_main_net_inflow_3d: '-150000000',
          dde_main_inflow_ratio_3d: '-0.05',
        }),
      ]);
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap[0]?.dde?.main_net_inflow_3d).toBe('-150000000');
      expect(snap[0]?.dde?.main_inflow_ratio_3d).toBe('-0.05');
    });

    it('is a no-op when given an empty batch', async () => {
      await writer.upsertFundFlow([]);
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap[0]?.dde).toBeNull();
    });

    it('silently drops rows whose code is absent from the meta file', async () => {
      await writer.upsertFundFlow([ddeRow({ code: '999999' }), ddeRow()]);
      const missing = await adapter.getOne('999999');
      expect(missing).toBeNull();
      const snap = await adapter.listSnapshots(['600519']);
      expect(snap[0]?.dde?.main_net_inflow_3d).toBe('300000000');
    });
  });
});
