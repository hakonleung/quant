/**
 * Tests for the /stock (search) cell — handler + renderer.
 *
 * Handler covers:
 *   - empty query → returns first `limit` rows
 *   - code substring + name substring + pinyin substring match
 *   - empty result on no match
 *   - snapshot fetch failure → rows still emitted with null numeric fields
 *
 * Renderer covers:
 *   - empty rows → "no match for X"
 *   - non-empty → subheader + stockTable* meta
 *   - error envelope passthrough
 */

import {
  emptyStockListRow,
  type InstructionEnvelope,
  type ResultOf,
  type StockListRow,
  type StockListRowsResponse,
  type StockMetaDto,
} from '@quant/shared';

import { buildStockCell } from '../../../src/modules/instruction-center/cells/stock.cell.js';
import { renderStock } from '../../../src/modules/instruction-center/cells/stock.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type {
  AssembleRowsArgs,
  StockListService,
} from '../../../src/modules/stock-list/stock-list.service.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';

type StockSearchResult = ResultOf<'stock'>;

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

function meta(code: string, name: string, pinyin: string): StockMetaDto {
  return {
    code,
    name,
    name_pinyin: pinyin,
    industries: '',
    list_date: '2020-01-01',
    float_pct: '1',
    updated_at: '2026-01-01T00:00:00.000Z',
    total_share: null,
    float_share: null,
    net_assets: null,
    net_assets_period: null,
    quarterlies: [],
    financials_updated_at: null,
  };
}

function fakeMeta(all: readonly StockMetaDto[]): StockMetaService {
  return {
    listAll: () => Promise.resolve(all),
  } as unknown as StockMetaService;
}

function emptyRow(code: string, name: string | null): StockListRow {
  return emptyStockListRow(code, name);
}

function fakeStockList(opts: {
  fail?: boolean;
  rowsByCode?: Readonly<Record<string, StockListRow>>;
}): StockListService {
  return {
    assembleRows: (args: AssembleRowsArgs): Promise<StockListRowsResponse> => {
      if (opts.fail === true) return Promise.reject(new Error('kline upstream down'));
      const rows = args.codes.map(
        (code) => opts.rowsByCode?.[code] ?? emptyRow(code, null),
      );
      return Promise.resolve({
        kind: args.kind,
        columns: [],
        sort: { key: 'chgPct', dir: 'desc' },
        rows,
      });
    },
  } as unknown as StockListService;
}

describe('buildStockCell.handler', () => {
  it('returns the first `limit` rows when query is empty', async () => {
    const all = [meta('600519', '茅台', 'mt'), meta('000001', '平安', 'pa')];
    const cell = buildStockCell({ stockMeta: fakeMeta(all), stockList: fakeStockList({}) });
    const r = await cell.handler({ q: '', limit: 1 }, ctx);
    expect(r.query).toBe('');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.code).toBe('600519');
  });

  it('matches by code substring', async () => {
    const all = [meta('600519', '茅台', 'mt'), meta('000001', '平安', 'pa')];
    const cell = buildStockCell({ stockMeta: fakeMeta(all), stockList: fakeStockList({}) });
    const r = await cell.handler({ q: '00000', limit: 10 }, ctx);
    expect(r.rows.map((x) => x.code)).toEqual(['000001']);
  });

  it('matches by name substring (case-insensitive)', async () => {
    const all = [meta('600519', '茅台', 'mt'), meta('000001', '平安', 'pa')];
    const cell = buildStockCell({ stockMeta: fakeMeta(all), stockList: fakeStockList({}) });
    const r = await cell.handler({ q: '茅', limit: 10 }, ctx);
    expect(r.rows.map((x) => x.code)).toEqual(['600519']);
  });

  it('matches by pinyin substring (case-insensitive)', async () => {
    const all = [meta('600519', '茅台', 'mt'), meta('000001', '平安', 'pa')];
    const cell = buildStockCell({ stockMeta: fakeMeta(all), stockList: fakeStockList({}) });
    const r = await cell.handler({ q: 'PA', limit: 10 }, ctx);
    expect(r.rows.map((x) => x.code)).toEqual(['000001']);
  });

  it('returns empty rows on no match (preserving original query for the renderer)', async () => {
    const all = [meta('600519', '茅台', 'mt')];
    const cell = buildStockCell({ stockMeta: fakeMeta(all), stockList: fakeStockList({}) });
    const r = await cell.handler({ q: 'nope', limit: 10 }, ctx);
    expect(r).toEqual<StockSearchResult>({ query: 'nope', rows: [] });
  });

  it('degrades gracefully when assembleRows throws — code-only rows still emitted', async () => {
    const all = [meta('600519', '茅台', 'mt')];
    const cell = buildStockCell({
      stockMeta: fakeMeta(all),
      stockList: fakeStockList({ fail: true }),
    });
    const r = await cell.handler({ q: '茅', limit: 10 }, ctx);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.code).toBe('600519');
    expect(r.rows[0]?.price).toBeNull();
    expect(r.rows[0]?.mktCap).toBeNull();
  });
});

describe('renderStock', () => {
  function okEnv(data: StockSearchResult): InstructionEnvelope<StockSearchResult> {
    return { ok: true, data };
  }

  it('renders "no match for X" on empty rows, echoing the original query', () => {
    const out = renderStock(okEnv({ query: 'foo', rows: [] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('no match for "foo"');
    expect(out.output.meta).toBeUndefined();
  });

  it('emits subheader + stockTable* meta on non-empty rows', () => {
    const out = renderStock(
      okEnv({
        query: '茅',
        rows: [
          {
            ...emptyStockListRow('600519', '茅台'),
            price: 1800,
            chgPct: 1.23,
            mktCap: 2.3e12,
            floatMktCap: 2.0e12,
            peTtm: 30,
          },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('stock matches (1)');
    expect(out.output.meta).toBeDefined();
    const meta = out.output.meta as {
      stockTableSubheader: string;
      stockTableRows: { code: string }[];
    };
    expect(meta.stockTableSubheader).toBe('stock matches (1)');
    expect(meta.stockTableRows[0]?.code).toBe('600519');
  });

  it('passes through error envelope verbatim', () => {
    const out = renderStock({ ok: false, error: { code: 'handler', message: 'down' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ code: 'handler', message: 'down' });
  });
});
