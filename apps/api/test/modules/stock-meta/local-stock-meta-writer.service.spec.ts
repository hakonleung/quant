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

import { FrozenClock } from '../../../src/common/clock.js';
import { LocalStockMetaAdapter } from '../../../src/modules/stock-meta/local-stock-meta.adapter.js';
import {
  LocalStockMetaWriterService,
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
});
