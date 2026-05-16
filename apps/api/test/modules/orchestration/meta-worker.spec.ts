/**
 * Worker-level test for {@link MetaWorker}.
 *
 * Verifies that each sub-step (basic enrich / financials enrich)
 * decodes the Arrow-shaped response from the Flight op and hands it
 * to `LocalStockMetaWriterService.upsertMetas`. Skipping by
 * blacklist is exercised too.
 */

import type { Table } from 'apache-arrow';
import type { StockMetaDto } from '@quant/shared';

import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import type { BlacklistStore } from '../../../src/modules/blacklist/blacklist.store.js';
import type { LocalStockMetaWriterService } from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import { MetaWorker } from '../../../src/modules/orchestration/meta-worker.js';
import type { JobEnvelope, MetaJob, ReQueue } from '../../../src/modules/orchestration/domain/types.js';

interface FakeProxy {
  toJSON(): Record<string, unknown>;
}

class FakeTable {
  constructor(private readonly rows: ReadonlyArray<Record<string, unknown>>) {}
  get numRows(): number {
    return this.rows.length;
  }
  get(i: number): FakeProxy | null {
    const row = this.rows[i];
    if (row === undefined) return null;
    return { toJSON: () => row };
  }
}

function flightStub(handlers: Record<string, FakeTable | Error>): {
  client: FlightClient;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      doGet: async (op: string): Promise<{ value: Table }> => {
        calls.push(op);
        const slot = handlers[op];
        if (slot === undefined) throw new Error(`unexpected op: ${op}`);
        if (slot instanceof Error) throw slot;
        return { value: slot as unknown as Table };
      },
    } as unknown as FlightClient,
  };
}

class FakeMetaWriter {
  metas: StockMetaDto[][] = [];
  upsertMetas(rows: readonly StockMetaDto[]): Promise<void> {
    this.metas.push([...rows]);
    return Promise.resolve();
  }
  upsertMetrics(): Promise<void> {
    throw new Error('not exercised by MetaWorker');
  }
}

const NOOP_QUEUE: ReQueue<MetaJob> = {
  enqueue: async () => undefined,
} as unknown as ReQueue<MetaJob>;

function blacklist(set: ReadonlySet<string>): BlacklistStore {
  return {
    has: (code: string): boolean => set.has(code),
  } as unknown as BlacklistStore;
}

function metaArrowRow(code: string, name: string): Record<string, unknown> {
  return {
    code,
    name,
    name_pinyin: name,
    industries: '银行',
    list_date: new Date('2001-01-01'),
    float_pct: '1',
    updated_at: new Date('2026-05-01T00:00:00Z'),
    total_share: '1000000',
    float_share: '1000000',
    net_assets: null,
    net_assets_period: null,
    quarterlies_json: null,
    financials_updated_at: null,
  };
}

function makeJob(overrides: Partial<MetaJob> = {}): JobEnvelope<MetaJob> {
  return {
    id: 'job-1',
    data: {
      code: '600519',
      traceId: 'tr-1',
      needBasic: true,
      needFinancials: false,
      ...overrides,
    },
  } as JobEnvelope<MetaJob>;
}

describe('MetaWorker.process', () => {
  it('routes the basic-enrich response to upsertMetas', async () => {
    const { client, calls } = flightStub({
      enrich_stock_meta_for_code: new FakeTable([metaArrowRow('600519', '贵州茅台')]),
    });
    const writer = new FakeMetaWriter();
    const worker = new MetaWorker(
      client,
      blacklist(new Set()),
      writer as unknown as LocalStockMetaWriterService,
    );

    await worker.process(makeJob({ needBasic: true, needFinancials: false }), NOOP_QUEUE);

    expect(calls).toEqual(['enrich_stock_meta_for_code']);
    expect(writer.metas).toHaveLength(1);
    expect(writer.metas[0]?.[0]?.name).toBe('贵州茅台');
  });

  it('routes the financials response to upsertMetas', async () => {
    const { client, calls } = flightStub({
      enrich_financials_for_code: new FakeTable([metaArrowRow('600519', '贵州茅台')]),
    });
    const writer = new FakeMetaWriter();
    const worker = new MetaWorker(
      client,
      blacklist(new Set()),
      writer as unknown as LocalStockMetaWriterService,
    );

    await worker.process(makeJob({ needBasic: false, needFinancials: true }), NOOP_QUEUE);

    expect(calls).toEqual(['enrich_financials_for_code']);
    expect(writer.metas).toHaveLength(1);
  });

  it('runs both sub-steps in order when both flags are set', async () => {
    const { client, calls } = flightStub({
      enrich_stock_meta_for_code: new FakeTable([metaArrowRow('600519', '贵州茅台')]),
      enrich_financials_for_code: new FakeTable([metaArrowRow('600519', '贵州茅台 v2')]),
    });
    const writer = new FakeMetaWriter();
    const worker = new MetaWorker(
      client,
      blacklist(new Set()),
      writer as unknown as LocalStockMetaWriterService,
    );

    await worker.process(makeJob({ needBasic: true, needFinancials: true }), NOOP_QUEUE);

    expect(calls).toEqual(['enrich_stock_meta_for_code', 'enrich_financials_for_code']);
    expect(writer.metas).toHaveLength(2);
    expect(writer.metas[0]?.[0]?.name).toBe('贵州茅台');
    expect(writer.metas[1]?.[0]?.name).toBe('贵州茅台 v2');
  });

  it('skips empty-response branches without calling the writer', async () => {
    const { client } = flightStub({
      enrich_stock_meta_for_code: new FakeTable([]),
    });
    const writer = new FakeMetaWriter();
    const worker = new MetaWorker(
      client,
      blacklist(new Set()),
      writer as unknown as LocalStockMetaWriterService,
    );

    await worker.process(makeJob({ needBasic: true, needFinancials: false }), NOOP_QUEUE);

    expect(writer.metas).toHaveLength(0);
  });

  it('short-circuits blacklisted A-share codes without any Flight call', async () => {
    const { client, calls } = flightStub({});
    const writer = new FakeMetaWriter();
    const worker = new MetaWorker(
      client,
      blacklist(new Set(['600519'])),
      writer as unknown as LocalStockMetaWriterService,
    );

    await worker.process(makeJob({ needBasic: true, needFinancials: true }), NOOP_QUEUE);

    expect(calls).toEqual([]);
    expect(writer.metas).toHaveLength(0);
  });
});
