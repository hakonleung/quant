/**
 * Focused tests for {@link CacheInspector.findMetaWork}.
 *
 * Storage-unify follow-up: meta reads are now served by
 * `LocalStockMetaAdapter` (via `StockMetaService.listAll`) and the
 * stale-financials filter runs locally in TS. The spec verifies the
 * field-completeness + watermark rules that used to live in Python's
 * `FinancialsService.find_stale_financials`.
 */

import type { StockMetaDto } from '@quant/shared';

import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import type { BlacklistStore } from '../../../src/modules/blacklist/blacklist.store.js';
import type { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';
import type { LocalStockMetaWriterService } from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';
import { CacheInspector } from '../../../src/modules/orchestration/cache-inspector.js';

const NOW = new Date('2026-05-16T08:00:00Z').getTime();
const _origNow = Date.now;
beforeAll(() => {
  Date.now = (): number => NOW;
});
afterAll(() => {
  Date.now = _origNow;
});

function meta(overrides: Partial<StockMetaDto> & Pick<StockMetaDto, 'code'>): StockMetaDto {
  const base: StockMetaDto = {
    code: overrides.code,
    name: overrides.code,
    name_pinyin: overrides.code,
    industries: '银行',
    list_date: '2001-01-01',
    float_pct: '1',
    updated_at: '2026-05-01T00:00:00+00:00',
    total_share: '1000000',
    float_share: '1000000',
    net_assets: null,
    net_assets_period: null,
    quarterlies: [
      {
        period: '2026-03-31',
        revenue: '100',
        operating_cost: '40',
        net_profit: '30',
        net_profit_excl_nr: '28',
      },
    ],
    financials_updated_at: '2026-05-15T00:00:00+00:00',
  };
  // Spread overrides explicitly to let callers pass `null` through (?? would coalesce it away).
  return { ...base, ...overrides };
}

function fakeStockMeta(rows: readonly StockMetaDto[]): StockMetaService {
  return {
    listAll: async () => rows,
  } as unknown as StockMetaService;
}

function fakeBlacklist(set: ReadonlySet<string>): BlacklistStore {
  return { has: (code: string) => set.has(code) } as unknown as BlacklistStore;
}

const NO_FLIGHT = {} as FlightClient;
const NO_KLINE = {} as KlineReaderService;
const NO_WRITER = {} as LocalStockMetaWriterService;

describe('CacheInspector.findMetaWork', () => {
  it('flags codes whose industries field is blank for basic enrich', async () => {
    const rows = [
      meta({ code: '600519', industries: '食品饮料,白酒' }),
      meta({ code: '000001', industries: '' }),
    ];
    const inspector = new CacheInspector(
      NO_FLIGHT,
      fakeBlacklist(new Set()),
      fakeStockMeta(rows),
      NO_KLINE,
      NO_WRITER,
    );

    const work = await inspector.findMetaWork('tr-1');
    const basic = work.filter((w) => w.needBasic);
    expect(basic.map((w) => w.code)).toEqual(['000001']);
  });

  it('flags codes missing total_share as needing financials', async () => {
    const rows = [
      meta({
        code: '600519',
        industries: '食品饮料,白酒',
        total_share: null,
      }),
    ];
    const inspector = new CacheInspector(
      NO_FLIGHT,
      fakeBlacklist(new Set()),
      fakeStockMeta(rows),
      NO_KLINE,
      NO_WRITER,
    );

    const work = await inspector.findMetaWork('tr-1');
    expect(work.map((w) => w.code)).toEqual(['600519']);
    expect(work[0]?.needFinancials).toBe(true);
  });

  it('flags codes whose recent quarterlies are missing operating_cost', async () => {
    const rows = [
      meta({
        code: '600519',
        industries: '食品饮料,白酒',
        quarterlies: [
          {
            period: '2026-03-31',
            revenue: '100',
            operating_cost: null,
            net_profit: '30',
            net_profit_excl_nr: null,
          },
        ],
      }),
    ];
    const inspector = new CacheInspector(
      NO_FLIGHT,
      fakeBlacklist(new Set()),
      fakeStockMeta(rows),
      NO_KLINE,
      NO_WRITER,
    );

    const work = await inspector.findMetaWork('tr-1');
    expect(work[0]?.needFinancials).toBe(true);
  });

  it('flags codes whose financials watermark is older than 7 days', async () => {
    const rows = [
      meta({
        code: '600519',
        industries: '食品饮料,白酒',
        financials_updated_at: '2026-05-01T00:00:00+00:00',
      }),
    ];
    const inspector = new CacheInspector(
      NO_FLIGHT,
      fakeBlacklist(new Set()),
      fakeStockMeta(rows),
      NO_KLINE,
      NO_WRITER,
    );

    const work = await inspector.findMetaWork('tr-1');
    expect(work[0]?.needFinancials).toBe(true);
  });

  it('omits fresh + complete codes from the work set', async () => {
    const rows = [meta({ code: '600519', industries: '食品饮料,白酒' })];
    const inspector = new CacheInspector(
      NO_FLIGHT,
      fakeBlacklist(new Set()),
      fakeStockMeta(rows),
      NO_KLINE,
      NO_WRITER,
    );

    const work = await inspector.findMetaWork('tr-1');
    expect(work).toEqual([]);
  });

  it('filters blacklisted A-share codes out of both branches', async () => {
    const rows = [
      meta({ code: '600519', industries: '' }), // needs basic
      meta({ code: '000001', total_share: null }), // needs financials
    ];
    const inspector = new CacheInspector(
      NO_FLIGHT,
      fakeBlacklist(new Set(['600519', '000001'])),
      fakeStockMeta(rows),
      NO_KLINE,
      NO_WRITER,
    );

    const work = await inspector.findMetaWork('tr-1');
    expect(work).toEqual([]);
  });
});
