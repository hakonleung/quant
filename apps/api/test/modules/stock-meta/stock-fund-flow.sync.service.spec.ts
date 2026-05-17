/**
 * Unit + integration test for {@link StockFundFlowSyncService}.
 *
 * Real bits: a temp kline parquet seeded via DuckDB + the real
 * {@link computeRatio} helper. Fakes: a stub `FlightClient` that returns
 * an Arrow-shaped table of per-window net-inflow rows, and a fake
 * `LocalStockMetaWriterService` that just captures the rows handed to
 * `upsertFundFlow`.
 *
 * Covers:
 *  - Golden path: ranks + amounts join → correct ratio per window.
 *  - Window-shorter-than-bars: ratio is null when local kline has < N bars.
 *  - sum_amount == 0 (e.g. fully halted): ratio null but net inflow lands.
 *  - Negative inflow flows through with a negative ratio.
 *  - Code absent from kline: net inflow lands, ratio null.
 *  - Empty rank table: writer is never called.
 *  - computeRatio: parses negatives + rounds to 6 dp.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { Table } from 'apache-arrow';

import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import type { LocalStockMetaWriterService } from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import {
  StockFundFlowSyncService,
  computeRatio,
} from '../../../src/modules/stock-meta/stock-fund-flow.sync.service.js';
import type { StockFundFlowRow } from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import { Decimal } from 'decimal.js';

interface FakeProxy {
  toJSON(): Record<string, unknown>;
}

class FakeTable {
  constructor(private readonly rows: readonly Record<string, unknown>[]) {}
  get numRows(): number {
    return this.rows.length;
  }
  get(i: number): FakeProxy | null {
    const row = this.rows[i];
    if (row === undefined) return null;
    return { toJSON: () => row };
  }
}

function flightStub(rankRows: readonly Record<string, unknown>[]): FlightClient {
  return {
    doGet: (op: string): Promise<{ value: Table; traceId: string }> => {
      if (op !== 'list_stock_fund_flow_ranks') {
        return Promise.reject(new Error(`unexpected op: ${op}`));
      }
      return Promise.resolve({
        value: new FakeTable(rankRows) as unknown as Table,
        traceId: 'tr-1',
      });
    },
  } as unknown as FlightClient;
}

class FakeWriter {
  upserts: StockFundFlowRow[][] = [];
  upsertFundFlow(rows: readonly StockFundFlowRow[]): Promise<void> {
    this.upserts.push([...rows]);
    return Promise.resolve();
  }
}

async function seedKline(
  dataRoot: string,
  bars: readonly { code: string; ts: string; amount: number }[],
): Promise<void> {
  const klineDir = join(dataRoot, 'kline');
  await mkdir(klineDir, { recursive: true });
  const inst = await DuckDBInstance.create(':memory:');
  const conn: DuckDBConnection = await inst.connect();
  await conn.run('CREATE TABLE kline (code VARCHAR, ts DATE, amount DOUBLE);');
  for (const bar of bars) {
    await conn.run(
      `INSERT INTO kline VALUES ('${bar.code}', DATE '${bar.ts}', ${String(bar.amount)});`,
    );
  }
  // One file per code prefix mirrors the LSM layout (`<prefix>.parquet`).
  const prefixes = new Set<string>();
  for (const bar of bars) prefixes.add(bar.code.slice(0, 3));
  for (const prefix of prefixes) {
    const target = join(klineDir, `${prefix}.parquet`);
    await conn.run(
      `COPY (SELECT * FROM kline WHERE code LIKE '${prefix}%') TO '${target}' (FORMAT PARQUET);`,
    );
  }
}

describe('StockFundFlowSyncService', () => {
  let dataRoot: string;
  let writer: FakeWriter;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'fund-flow-sync-'));
    writer = new FakeWriter();
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  function svc(rankRows: readonly Record<string, unknown>[]): StockFundFlowSyncService {
    return new StockFundFlowSyncService(
      flightStub(rankRows),
      writer as unknown as LocalStockMetaWriterService,
      dataRoot,
    );
  }

  it('computes ratio = net_inflow / sum(amount, N) per window', async () => {
    // 20 daily bars of 1.5e8 amount each → sum_3d=4.5e8, sum_5d=7.5e8, …
    const bars = Array.from({ length: 25 }, (_, i) => ({
      code: '600519',
      ts: `2026-04-${String(i + 1).padStart(2, '0')}`,
      amount: 150_000_000,
    }));
    await seedKline(dataRoot, bars);
    const ranks = [
      {
        code: '600519',
        main_net_inflow_3d: '45000000',
        main_net_inflow_5d: '75000000',
        main_net_inflow_10d: '150000000',
        main_net_inflow_20d: '300000000',
      },
    ];
    const result = await svc(ranks).syncAll();

    expect(result).toEqual({ ranked: 1, written: 1 });
    expect(writer.upserts).toHaveLength(1);
    const row = writer.upserts[0]?.[0];
    expect(row?.code).toBe('600519');
    expect(row?.dde_main_net_inflow_3d).toBe('45000000');
    // ratio 3d = 45e6 / 450e6 = 0.1
    expect(row?.dde_main_inflow_ratio_3d).toBe('0.1');
    expect(row?.dde_main_inflow_ratio_5d).toBe('0.1');
    expect(row?.dde_main_inflow_ratio_10d).toBe('0.1');
    expect(row?.dde_main_inflow_ratio_20d).toBe('0.1');
  });

  it('null ratio for windows shorter than the kline tail', async () => {
    // Only 4 bars → 3d ratio is computable, 5/10/20 are not.
    const bars = Array.from({ length: 4 }, (_, i) => ({
      code: '600519',
      ts: `2026-04-${String(i + 1).padStart(2, '0')}`,
      amount: 100_000_000,
    }));
    await seedKline(dataRoot, bars);
    await svc([
      {
        code: '600519',
        main_net_inflow_3d: '30000000',
        main_net_inflow_5d: '50000000',
        main_net_inflow_10d: '90000000',
        main_net_inflow_20d: '180000000',
      },
    ]).syncAll();

    const row = writer.upserts[0]?.[0];
    // 3 bars present → ratio_3d = 30e6 / 300e6 = 0.1
    expect(row?.dde_main_inflow_ratio_3d).toBe('0.1');
    // bar_count=4 < 5 → ratio_5d, ratio_10d, ratio_20d all null
    expect(row?.dde_main_inflow_ratio_5d).toBeNull();
    expect(row?.dde_main_inflow_ratio_10d).toBeNull();
    expect(row?.dde_main_inflow_ratio_20d).toBeNull();
    // Net inflow always lands.
    expect(row?.dde_main_net_inflow_20d).toBe('180000000');
  });

  it('null ratio when sum_amount == 0 (full halt)', async () => {
    const bars = Array.from({ length: 25 }, (_, i) => ({
      code: '600519',
      ts: `2026-04-${String(i + 1).padStart(2, '0')}`,
      amount: 0,
    }));
    await seedKline(dataRoot, bars);
    await svc([
      {
        code: '600519',
        main_net_inflow_3d: '10000000',
        main_net_inflow_5d: '10000000',
        main_net_inflow_10d: '10000000',
        main_net_inflow_20d: '10000000',
      },
    ]).syncAll();
    const row = writer.upserts[0]?.[0];
    expect(row?.dde_main_inflow_ratio_3d).toBeNull();
    expect(row?.dde_main_inflow_ratio_20d).toBeNull();
    expect(row?.dde_main_net_inflow_3d).toBe('10000000');
  });

  it('emits a negative ratio for net outflow over a positive amount', async () => {
    const bars = Array.from({ length: 25 }, (_, i) => ({
      code: '600519',
      ts: `2026-04-${String(i + 1).padStart(2, '0')}`,
      amount: 100_000_000,
    }));
    await seedKline(dataRoot, bars);
    await svc([
      {
        code: '600519',
        main_net_inflow_3d: '-30000000',
        main_net_inflow_5d: null,
        main_net_inflow_10d: null,
        main_net_inflow_20d: null,
      },
    ]).syncAll();
    const row = writer.upserts[0]?.[0];
    expect(row?.dde_main_inflow_ratio_3d).toBe('-0.1');
    expect(row?.dde_main_net_inflow_3d).toBe('-30000000');
  });

  it('codes with no local kline land with all ratios null', async () => {
    await seedKline(dataRoot, []);
    await svc([
      {
        code: '600519',
        main_net_inflow_3d: '300000000',
        main_net_inflow_5d: null,
        main_net_inflow_10d: null,
        main_net_inflow_20d: null,
      },
    ]).syncAll();
    const row = writer.upserts[0]?.[0];
    expect(row?.dde_main_net_inflow_3d).toBe('300000000');
    expect(row?.dde_main_inflow_ratio_3d).toBeNull();
  });

  it('null inflow → null ratio even when amount sum is healthy', async () => {
    const bars = Array.from({ length: 25 }, (_, i) => ({
      code: '600519',
      ts: `2026-04-${String(i + 1).padStart(2, '0')}`,
      amount: 100_000_000,
    }));
    await seedKline(dataRoot, bars);
    await svc([
      {
        code: '600519',
        main_net_inflow_3d: null,
        main_net_inflow_5d: '10000000',
        main_net_inflow_10d: null,
        main_net_inflow_20d: null,
      },
    ]).syncAll();
    const row = writer.upserts[0]?.[0];
    expect(row?.dde_main_inflow_ratio_3d).toBeNull();
    // 5d window: ratio = 1e7 / 5e8 = 0.02
    expect(row?.dde_main_inflow_ratio_5d).toBe('0.02');
  });

  it('skips writer entirely on an empty rank table', async () => {
    await seedKline(dataRoot, []);
    const result = await svc([]).syncAll();
    expect(result).toEqual({ ranked: 0, written: 0 });
    expect(writer.upserts).toHaveLength(0);
  });
});

describe('computeRatio', () => {
  it('returns null when inflow is null', () => {
    expect(computeRatio(null, new Decimal(1))).toBeNull();
  });

  it('returns null when amount is null', () => {
    expect(computeRatio('100', null)).toBeNull();
  });

  it('returns null when amount is zero', () => {
    expect(computeRatio('100', new Decimal(0))).toBeNull();
  });

  it('rounds to 6 decimal places with half-even rounding', () => {
    // 1 / 3 → 0.333333 (truncated, half-even)
    expect(computeRatio('1', new Decimal(3))).toBe('0.333333');
  });

  it('handles negative inflow', () => {
    expect(computeRatio('-50', new Decimal(500))).toBe('-0.1');
  });
});
