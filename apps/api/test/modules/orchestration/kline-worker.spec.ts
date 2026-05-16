/**
 * Worker-level integration test for {@link KlineWorker}.
 *
 * Drives the post storage-unify-rollout flow end-to-end inside one
 * process: a fake `FlightClient` returns Arrow-shaped tables for the
 * `sync_kline_for_code` and `compute_stock_metrics_for_code` ops; the
 * worker should forward them to `KlineWriterService.appendBars` and
 * `LocalStockMetaWriterService.upsertMetrics` respectively, with
 * step (2) treated as best-effort.
 *
 * No real Flight server or real parquet file is involved — the spec
 * proves the wiring (Arrow → mapper → writer) without depending on
 * the Python process being up.
 */

import type { Table } from 'apache-arrow';
import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import { KlineWorker } from '../../../src/modules/orchestration/kline-worker.js';
import type { KlineWriterService } from '../../../src/modules/kline/kline-writer.service.js';
import type { LocalStockMetaWriterService } from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import type { KlineRow } from '../../../src/modules/kline/kline.row.js';
import type {
  StockMetricsRow,
} from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import type { JobEnvelope, KlineJob, ReQueue } from '../../../src/modules/orchestration/domain/types.js';

interface FakeProxy {
  toJSON(): Record<string, unknown>;
}

class FakeTable {
  constructor(
    private readonly rows: ReadonlyArray<Record<string, unknown>>,
    private readonly metadata: Record<string, string> = {},
  ) {}
  get numRows(): number {
    return this.rows.length;
  }
  get(i: number): FakeProxy | null {
    const row = this.rows[i];
    if (row === undefined) return null;
    return { toJSON: () => row };
  }
  // Mirror apache-arrow's `Table.schema.metadata` (Map<string,string>).
  get schema(): { metadata: Map<string, string> } {
    return { metadata: new Map(Object.entries(this.metadata)) };
  }
}

function flightStub(handlers: Record<string, FakeTable | Error>): FlightClient {
  return {
    doGet: async (op: string): Promise<{ value: Table }> => {
      const slot = handlers[op];
      if (slot === undefined) throw new Error(`unexpected op: ${op}`);
      if (slot instanceof Error) throw slot;
      return { value: slot as unknown as Table };
    },
  } as unknown as FlightClient;
}

class FakeKlineWriter {
  appended: KlineRow[][] = [];
  appendBars(rows: readonly KlineRow[]): Promise<void> {
    this.appended.push([...rows]);
    return Promise.resolve();
  }
}

class FakeMetaWriter {
  metrics: StockMetricsRow[][] = [];
  metas: unknown[] = [];
  upsertMetrics(rows: readonly StockMetricsRow[]): Promise<void> {
    this.metrics.push([...rows]);
    return Promise.resolve();
  }
  upsertMetas(rows: readonly unknown[]): Promise<void> {
    this.metas.push([...rows]);
    return Promise.resolve();
  }
}

const NOOP_QUEUE: ReQueue<KlineJob> = {
  enqueue: async () => undefined,
} as unknown as ReQueue<KlineJob>;

function makeJob(code = '600519'): JobEnvelope<KlineJob> {
  return {
    id: 'job-1',
    data: { code, traceId: 'tr-1' },
  } as JobEnvelope<KlineJob>;
}

const SYNC_BARS_TABLE = new FakeTable(
  [
    {
      code: '600519',
      ts: new Date('2026-05-15'),
      open_qfq: 1700,
      high_qfq: 1710,
      low_qfq: 1695,
      close_qfq: 1705,
      volume: 1_000_000,
      amount: 1_700_000_000,
      turnover_rate: 0.0007,
      ma5: 1690,
      ma10: 1680,
      ma20: 1670,
      ma60: 1600,
    },
  ],
  {
    code: '600519',
    mode: 'incremental',
    fetched_bars: '1',
    written_bars: '1',
    new_last_date: '2026-05-15',
  },
);

const METRICS_TABLE = new FakeTable([
  {
    code: '600519',
    asof: new Date('2026-05-15'),
    metrics_price: '1705',
    ret_1d: '0.005',
    ret_5d: '0.02',
    ret_10d: '0.05',
    ret_20d: '0.10',
    ret_90d: '0.20',
    ret_250d: '0.30',
    mkt_cap: '2140000000000',
    float_mkt_cap: '2140000000000',
    pe_ttm: '24.5',
    pe_dynamic: '23.1',
    pb: '7.8',
    peg: '0.6',
    gross_margin_ttm: '0.916',
  },
]);

describe('KlineWorker.process', () => {
  it('writes bars then upserts metrics in order', async () => {
    const flight = flightStub({
      sync_kline_for_code: SYNC_BARS_TABLE,
      compute_stock_metrics_for_code: METRICS_TABLE,
    });
    const klineWriter = new FakeKlineWriter();
    const metaWriter = new FakeMetaWriter();
    const worker = new KlineWorker(
      flight,
      klineWriter as unknown as KlineWriterService,
      metaWriter as unknown as LocalStockMetaWriterService,
    );

    await worker.process(makeJob(), NOOP_QUEUE);

    expect(klineWriter.appended).toHaveLength(1);
    expect(klineWriter.appended[0]).toHaveLength(1);
    expect(klineWriter.appended[0]?.[0]?.code).toBe('600519');
    expect(metaWriter.metrics).toHaveLength(1);
    expect(metaWriter.metrics[0]?.[0]?.code).toBe('600519');
    expect(metaWriter.metrics[0]?.[0]?.metricsPrice).toBe('1705');
  });

  it('treats compute_stock_metrics_for_code failure as best-effort', async () => {
    const flight = flightStub({
      sync_kline_for_code: SYNC_BARS_TABLE,
      compute_stock_metrics_for_code: new Error('flight down'),
    });
    const klineWriter = new FakeKlineWriter();
    const metaWriter = new FakeMetaWriter();
    const worker = new KlineWorker(
      flight,
      klineWriter as unknown as KlineWriterService,
      metaWriter as unknown as LocalStockMetaWriterService,
    );

    await expect(worker.process(makeJob(), NOOP_QUEUE)).resolves.toBeUndefined();
    expect(klineWriter.appended).toHaveLength(1);
    expect(metaWriter.metrics).toHaveLength(0);
  });

  it('skips appendBars when sync returns no bars', async () => {
    const flight = flightStub({
      sync_kline_for_code: new FakeTable([], {
        code: '600519',
        mode: 'skip',
        fetched_bars: '0',
        written_bars: '0',
        new_last_date: '',
      }),
      compute_stock_metrics_for_code: new FakeTable([]),
    });
    const klineWriter = new FakeKlineWriter();
    const metaWriter = new FakeMetaWriter();
    const worker = new KlineWorker(
      flight,
      klineWriter as unknown as KlineWriterService,
      metaWriter as unknown as LocalStockMetaWriterService,
    );

    await worker.process(makeJob(), NOOP_QUEUE);

    expect(klineWriter.appended).toHaveLength(0);
    // compute returned empty → writer not called either
    expect(metaWriter.metrics).toHaveLength(0);
  });
});
