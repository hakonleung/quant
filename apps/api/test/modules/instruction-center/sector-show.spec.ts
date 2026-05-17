/**
 * Tests for the /sector.show cell — handler + renderer.
 *
 * Handler:
 *   - golden path: resolves sector, slices codes, fetches stock rows
 *   - QuantError(NOT_FOUND) → not-found
 *   - >MAX_TABLE_ROWS (30) caps codes, preserves totalCount
 *   - dynamic-sector evidence keys + values pre-formatted
 *   - assembleRows throws → stockRows=null
 *
 * Renderer:
 *   - header line with id/name/kind/by/[PUB]/count
 *   - "+N more" tail when totalCount > codes.length
 *   - stockRows=null → code list fallback (no meta)
 *   - stockRows non-empty → text + stockTable* meta with evidence cols
 *   - error envelope passthrough
 */

import {
  QuantError,
  type InstructionEnvelope,
  type ResultOf,
  type Sector,
  type StockListRow,
} from '@quant/shared';

import { buildSectorShowCell } from '../../../src/modules/instruction-center/cells/sector-show.cell.js';
import { renderSectorShow } from '../../../src/modules/instruction-center/cells/sector-show.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { SectorsService } from '../../../src/modules/sectors/sectors.service.js';
import type { StockListService } from '../../../src/modules/stock-list/stock-list.service.js';

type SectorShowResult = ResultOf<'sector.show'>;

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
  wcmi: null,
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

function userSector(overrides: Partial<Sector> = {}): Sector {
  return {
    id: 's1',
    name: 'mine',
    kind: 'user',
    count: 1,
    meta: '',
    chgPct: null,
    codes: ['600519'],
    createdBy: 'me',
    published: false,
    ...overrides,
  } as Sector;
}

function dynamicSector(overrides: Partial<Sector> = {}): Sector {
  return {
    id: 's2',
    name: '白酒',
    kind: 'dynamic',
    count: 2,
    meta: '',
    chgPct: null,
    codes: ['600519', '000858'],
    createdBy: 'someone-else',
    published: true,
    evidence: {
      '600519': { rsi14: 0.65, vol_ratio: 1.45 },
      '000858': { rsi14: 0.55 },
    },
    ...overrides,
  } as Sector;
}

interface FakeSectorsOpts {
  readonly resolved?: Sector;
  readonly resolveError?: Error;
}

function fakeSectors(opts: FakeSectorsOpts = {}): SectorsService {
  return {
    resolveVisible: () => {
      if (opts.resolveError !== undefined) throw opts.resolveError;
      return opts.resolved ?? userSector();
    },
  } as unknown as SectorsService;
}

function fakeStockList(opts: {
  rows?: StockListRow[];
  shouldThrow?: boolean;
}): {
  service: StockListService;
  calls: { kind: string; codes: readonly string[]; evidenceByCode?: unknown }[];
} {
  const calls: { kind: string; codes: readonly string[]; evidenceByCode?: unknown }[] = [];
  const service = {
    assembleRows: (args: { kind: string; codes: readonly string[]; evidenceByCode?: unknown }) => {
      calls.push(args);
      if (opts.shouldThrow === true) return Promise.reject(new Error('snapshot down'));
      return Promise.resolve({ rows: opts.rows ?? [] });
    },
  } as unknown as StockListService;
  return { service, calls };
}

describe('buildSectorShowCell.handler', () => {
  it('golden path returns sector identity + sliced codes + stock rows', async () => {
    const cell = buildSectorShowCell({
      sectors: fakeSectors(),
      stockList: fakeStockList({ rows: [emptyRow('600519')] }).service,
    });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r.id).toBe('s1');
    expect(r.name).toBe('mine');
    expect(r.kind).toBe('user');
    expect(r.isOwn).toBe(true);
    expect(r.published).toBe(false);
    expect(r.codes).toEqual(['600519']);
    expect(r.totalCount).toBe(1);
    expect(r.stockRows).toHaveLength(1);
    expect(r.evidenceKeys).toEqual([]);
    expect(r.evidenceByCode).toEqual({});
  });

  it('marks isOwn=false when sector belongs to someone else', async () => {
    const cell = buildSectorShowCell({
      sectors: fakeSectors({
        resolved: userSector({ createdBy: 'other-user', published: true }),
      }),
      stockList: fakeStockList({ rows: [emptyRow('600519')] }).service,
    });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r.isOwn).toBe(false);
    expect(r.published).toBe(true);
  });

  it('maps QuantError(NOT_FOUND) → not-found', async () => {
    const cell = buildSectorShowCell({
      sectors: fakeSectors({
        resolveError: new QuantError('NOT_FOUND', 'no such sector', {}),
      }),
      stockList: fakeStockList({}).service,
    });
    await expect(cell.handler({ id: 'ghost' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'not-found',
    });
  });

  it('caps codes at MAX_TABLE_ROWS (30) but preserves totalCount', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => String(600000 + i));
    const cell = buildSectorShowCell({
      sectors: fakeSectors({
        resolved: userSector({ codes, count: 50 }),
      }),
      stockList: fakeStockList({ rows: codes.slice(0, 30).map(emptyRow) }).service,
    });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r.codes).toHaveLength(30);
    expect(r.totalCount).toBe(50);
  });

  it('emits sorted evidenceKeys + formatted evidence values for dynamic sectors', async () => {
    const cell = buildSectorShowCell({
      sectors: fakeSectors({ resolved: dynamicSector() }),
      stockList: fakeStockList({ rows: [emptyRow('600519'), emptyRow('000858')] }).service,
    });
    const r = await cell.handler({ id: 's2' }, ctx);
    expect(r.evidenceKeys).toEqual(['rsi14', 'vol_ratio']);
    // 0.65 < 1 → 4 decimals; 1.45 ≥ 1 → 2 decimals
    expect(r.evidenceByCode['600519']).toEqual({ rsi14: '0.6500', vol_ratio: '1.45' });
    expect(r.evidenceByCode['000858']).toEqual({ rsi14: '0.5500' });
  });

  it('omits evidence for user sectors', async () => {
    const cell = buildSectorShowCell({
      sectors: fakeSectors({ resolved: userSector() }),
      stockList: fakeStockList({ rows: [emptyRow('600519')] }).service,
    });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r.evidenceKeys).toEqual([]);
    expect(r.evidenceByCode).toEqual({});
  });

  it('degrades stockRows to null when assembleRows throws', async () => {
    const cell = buildSectorShowCell({
      sectors: fakeSectors(),
      stockList: fakeStockList({ shouldThrow: true }).service,
    });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r.stockRows).toBeNull();
    expect(r.codes).toEqual(['600519']);
  });

  it('passes dynamic-sector evidenceByCode through to assembleRows', async () => {
    const { service, calls } = fakeStockList({
      rows: [emptyRow('600519'), emptyRow('000858')],
    });
    const cell = buildSectorShowCell({
      sectors: fakeSectors({ resolved: dynamicSector() }),
      stockList: service,
    });
    await cell.handler({ id: 's2' }, ctx);
    expect(calls[0]?.kind).toBe('dynamic-sector');
    const ev = calls[0]?.evidenceByCode as
      | Record<string, Record<string, string>>
      | undefined;
    expect(ev?.['600519']?.['rsi14']).toBe('0.6500');
  });
});

describe('renderSectorShow', () => {
  function okEnv(d: SectorShowResult): InstructionEnvelope<SectorShowResult> {
    return { ok: true, data: d };
  }

  it('renders header with id/name/kind/by-me + count and [PUB] when published', () => {
    const out = renderSectorShow(
      okEnv({
        id: 's1',
        name: 'mine',
        kind: 'user',
        createdBy: 'me',
        isOwn: true,
        published: true,
        totalCount: 1,
        codes: ['600519'],
        stockRows: [emptyRow('600519')],
        evidenceKeys: [],
        evidenceByCode: {},
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('s1  mine  [user]');
    expect(out.output.text).toContain('by me');
    expect(out.output.text).toContain('[PUB]');
    expect(out.output.text).toContain('count=1');
  });

  it('renders "by <otherUser>" when not own', () => {
    const out = renderSectorShow(
      okEnv({
        id: 's2',
        name: 'shared',
        kind: 'user',
        createdBy: 'other-user',
        isOwn: false,
        published: false,
        totalCount: 1,
        codes: ['600519'],
        stockRows: [emptyRow('600519')],
        evidenceKeys: [],
        evidenceByCode: {},
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('by other-user');
    expect(out.output.text).not.toContain('[PUB]');
  });

  it('emits "+N more" tail when totalCount > codes.length', () => {
    const out = renderSectorShow(
      okEnv({
        id: 's1',
        name: 'mine',
        kind: 'user',
        createdBy: 'me',
        isOwn: true,
        published: false,
        totalCount: 50,
        codes: Array.from({ length: 30 }, (_, i) => String(600000 + i)),
        stockRows: null,
        evidenceKeys: [],
        evidenceByCode: {},
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('+20 more');
  });

  it('falls back to comma-joined code list when stockRows=null', () => {
    const out = renderSectorShow(
      okEnv({
        id: 's1',
        name: 'mine',
        kind: 'user',
        createdBy: 'me',
        isOwn: true,
        published: false,
        totalCount: 1,
        codes: ['600519'],
        stockRows: null,
        evidenceKeys: [],
        evidenceByCode: {},
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('600519');
    expect(out.output.meta).toBeUndefined();
  });

  it('emits stockTable* meta with evidence columns for dynamic sectors', () => {
    const out = renderSectorShow(
      okEnv({
        id: 's2',
        name: '白酒',
        kind: 'dynamic',
        createdBy: 'other',
        isOwn: false,
        published: true,
        totalCount: 1,
        codes: ['600519'],
        stockRows: [emptyRow('600519')],
        evidenceKeys: ['rsi14'],
        evidenceByCode: { '600519': { rsi14: '0.6500' } },
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.meta).toBeDefined();
    const meta = out.output.meta as {
      stockTableColumns: { name: string }[];
      stockTableRows: { code: string }[];
    };
    expect(meta.stockTableRows[0]?.code).toBe('600519');
    // Evidence columns are prefixed `ev_` by stockTableMetaColumns.
    expect(meta.stockTableColumns.some((c) => c.name === 'ev_rsi14')).toBe(true);
  });

  it('passes through error envelope', () => {
    const out = renderSectorShow({ ok: false, error: { code: 'not-found', message: 'gone' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('not-found');
  });
});
