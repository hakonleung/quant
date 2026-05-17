/**
 * Tests for the /screen cell — handler + renderer.
 *
 * Handler:
 *   - golden path with matches → assembles stock rows
 *   - QuantError from runNl → handler envelope
 *   - assembleRows throws → stockRows=null, codes still emitted
 *   - empty matches → totalMatches=0, codes=[]
 *   - >MAX cap → totalMatches/displayedCount diverge
 *
 * Renderer:
 *   - empty → "(no matches)"
 *   - non-empty + stockRows → text + stockTable meta
 *   - stockRows=null → fallback to code list
 *   - "+N more" tail when capped
 *   - error envelope passthrough
 */

import {
  QuantError,
  type InstructionEnvelope,
  type ResultOf,
  type StockListRow,
} from '@quant/shared';

import { buildScreenCell } from '../../../src/modules/instruction-center/cells/screen.cell.js';
import { renderScreen } from '../../../src/modules/instruction-center/cells/screen.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { ScreenService } from '../../../src/modules/screen/screen.service.js';
import type { StockListService } from '../../../src/modules/stock-list/stock-list.service.js';

type ScreenResult = ResultOf<'screen'>;

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

const emptyRow = (code: string): StockListRow => ({
  code,
  name: code,
  price: null,
  chgPct: null,
  turnoverRate: null,
  turnover: null,
  consecUp: null,
  ret5d: null,
  ret10d: null,
  ret20d: null,
  ret90d: null,
  ret250d: null,
  mktCap: null,
  floatMktCap: null,
  peTtm: null,
  peDynamic: null,
  pb: null,
  peg: null,
  grossMargin: null,
  ddeMainInflow3d: null,
  ddeMainInflow5d: null,
  ddeMainInflow10d: null,
  ddeMainInflow20d: null,
  ddeMainInflowRatio3d: null,
  ddeMainInflowRatio5d: null,
  ddeMainInflowRatio10d: null,
  ddeMainInflowRatio20d: null,
});

function fakeScreen(opts: {
  readonly result?: { nl: string; asof: string; matches: { code: string }[] };
  readonly reject?: Error;
}): ScreenService {
  return {
    runNl: () =>
      opts.reject !== undefined
        ? Promise.reject(opts.reject)
        : Promise.resolve(
            opts.result ?? {
              nl: '测试',
              asof: '2026-05-01',
              matches: [{ code: '600519' }],
              screenPlan: { kind: 'true' },
              universePlan: null,
              rank: null,
              planSignature: 'sig',
            },
          ),
  } as unknown as ScreenService;
}

function fakeStockList(rows: StockListRow[], shouldThrow = false): StockListService {
  return {
    assembleRows: () =>
      shouldThrow ? Promise.reject(new Error('snapshot down')) : Promise.resolve({ rows }),
  } as unknown as StockListService;
}

describe('buildScreenCell.handler', () => {
  it('golden path returns nl/asof/matches/stockRows', async () => {
    const cell = buildScreenCell({
      screen: fakeScreen({}),
      stockList: fakeStockList([emptyRow('600519')]),
    });
    const r = await cell.handler({ q: '测试', confirm: false }, ctx);
    expect(r.nl).toBe('测试');
    expect(r.totalMatches).toBe(1);
    expect(r.displayedCount).toBe(1);
    expect(r.codes).toEqual(['600519']);
    expect(r.stockRows).toHaveLength(1);
  });

  it('maps QuantError from runNl → handler', async () => {
    const cell = buildScreenCell({
      screen: fakeScreen({ reject: new QuantError('NL_TRANSLATION_FAILED', 'bad q', {}) }),
      stockList: fakeStockList([]),
    });
    await expect(
      cell.handler({ q: 'bad', confirm: false }, ctx),
    ).rejects.toMatchObject({ name: 'InstructionDispatchError', code: 'handler' });
  });

  it('propagates non-QuantError throws', async () => {
    const cell = buildScreenCell({
      screen: fakeScreen({ reject: new Error('net down') }),
      stockList: fakeStockList([]),
    });
    await expect(
      cell.handler({ q: 'x', confirm: false }, ctx),
    ).rejects.toThrow('net down');
  });

  it('degrades stockRows to null when assembleRows throws', async () => {
    const cell = buildScreenCell({
      screen: fakeScreen({}),
      stockList: fakeStockList([], true),
    });
    const r = await cell.handler({ q: '测试', confirm: false }, ctx);
    expect(r.stockRows).toBeNull();
    expect(r.codes).toEqual(['600519']);
  });

  it('returns zero-match result when matches=[]', async () => {
    const cell = buildScreenCell({
      screen: fakeScreen({
        result: { nl: 'empty', asof: '2026-05-01', matches: [] },
      }),
      stockList: fakeStockList([]),
    });
    const r = await cell.handler({ q: 'empty', confirm: false }, ctx);
    expect(r.totalMatches).toBe(0);
    expect(r.codes).toEqual([]);
    expect(r.stockRows).toBeNull();
  });

  it('caps displayedCount at MAX_MATCHES_DISPLAY (30) while preserving totalMatches', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ code: String(600000 + i) }));
    const cell = buildScreenCell({
      screen: fakeScreen({
        result: { nl: 'huge', asof: '2026-05-01', matches: many },
      }),
      stockList: fakeStockList(many.slice(0, 30).map((m) => emptyRow(m.code))),
    });
    const r = await cell.handler({ q: 'huge', confirm: false }, ctx);
    expect(r.totalMatches).toBe(50);
    expect(r.displayedCount).toBe(30);
    expect(r.codes).toHaveLength(30);
  });
});

describe('renderScreen', () => {
  function okEnv(d: ScreenResult): InstructionEnvelope<ScreenResult> {
    return { ok: true, data: d };
  }

  it('emits "(no matches)" when totalMatches=0', () => {
    const out = renderScreen(
      okEnv({ nl: 'q', asof: '2026-05-01', totalMatches: 0, displayedCount: 0, codes: [], stockRows: null }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('(no matches)');
  });

  it('emits stockTable meta on non-empty result with stockRows', () => {
    const out = renderScreen(
      okEnv({
        nl: 'q',
        asof: '2026-05-01',
        totalMatches: 1,
        displayedCount: 1,
        codes: ['600519'],
        stockRows: [emptyRow('600519')],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.meta).toBeDefined();
    const meta = out.output.meta as { stockTableRows: { code: string }[] };
    expect(meta.stockTableRows[0]?.code).toBe('600519');
  });

  it('falls back to code list when stockRows=null', () => {
    const out = renderScreen(
      okEnv({
        nl: 'q',
        asof: '2026-05-01',
        totalMatches: 1,
        displayedCount: 1,
        codes: ['600519'],
        stockRows: null,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('600519');
    expect(out.output.meta).toBeUndefined();
  });

  it('emits "+N more" tail when displayedCount < totalMatches', () => {
    const out = renderScreen(
      okEnv({
        nl: 'q',
        asof: '2026-05-01',
        totalMatches: 50,
        displayedCount: 30,
        codes: Array.from({ length: 30 }, (_, i) => String(600000 + i)),
        stockRows: null,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('+20 more');
  });

  it('passes through error envelope', () => {
    const out = renderScreen({ ok: false, error: { code: 'handler', message: 'down' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('handler');
  });
});
