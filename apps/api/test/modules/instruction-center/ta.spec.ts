/**
 * Tests for the /ta and /ta.sector cells.
 *
 * /ta:
 *   - golden path returns TaAnalysis
 *   - QuantError → validation
 *   - non-QuantError propagates
 *   - peek: cache hit → true, fresh=true → false, miss → false, throw → false
 *
 * /ta.sector:
 *   - golden path returns { sectorId, sectorName, analysis }
 *   - QuantError(NOT_FOUND) on resolveVisible → not-found
 *   - empty / oversized sector → validation
 *   - QuantError from analyzeSector → handler
 *   - no peek hook (aggregate has no cache)
 *
 * Renderers: text wording matches the legacy formatTaAnalysis /
 * formatSectorAnalysis exactly so IM/term users see the same output
 * after migration. Error envelope passthrough.
 */

import {
  QuantError,
  type InstructionEnvelope,
  type TaResult,
  type TaSectorResult,
} from '@quant/shared';

import { buildTaCell } from '../../../src/modules/instruction-center/cells/ta.cell.js';
import {
  formatSectorAnalysis,
  formatTaAnalysis,
  renderTa,
  renderTaSector,
} from '../../../src/modules/instruction-center/cells/ta.render.js';
import { buildTaSectorCell } from '../../../src/modules/instruction-center/cells/ta-sector.cell.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { SectorsService } from '../../../src/modules/sectors/sectors.service.js';
import type { TaService } from '../../../src/modules/ta/ta.service.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

const sampleTa: TaResult = {
  code: '600519',
  asof: '2026-05-01',
  barsCount: 250,
  trend: { direction: 'up', confidence: 0.72, rationale: '突破前高', horizonDays: 5 },
  supportLevels: [{ price: '1700' }, { price: '1650' }],
  resistanceLevels: [{ price: '1850' }],
  patterns: [],
  caveats: [],
  provider: 'deepseek',
  cachedAt: '2026-05-01T00:00:00.000Z',
} as unknown as TaResult;

const sampleSectorAnalysis: TaSectorResult['analysis'] = {
  codes: ['600519'],
  members: [{ code: '600519', direction: 'up', confidence: 0.7 }],
  overallDirection: 'up',
  overallConfidence: 0.65,
  trendBreakdown: { up: 1, down: 0, sideways: 0 },
  summary: '板块整体偏多',
  caveats: [],
  cachedAt: '2026-05-01T00:00:00.000Z',
} as unknown as TaSectorResult['analysis'];

// ── /ta ─────────────────────────────────────────────────────────────────

function fakeTa(opts: {
  readonly result?: TaResult;
  readonly reject?: Error;
  readonly cached?: TaResult | null;
  readonly cachedThrows?: boolean;
  readonly sectorResult?: TaSectorResult['analysis'];
  readonly sectorReject?: Error;
}): TaService {
  return {
    analyzeOne: () =>
      opts.reject !== undefined
        ? Promise.reject(opts.reject)
        : Promise.resolve(opts.result ?? sampleTa),
    getCached: () =>
      opts.cachedThrows === true
        ? Promise.reject(new Error('cache down'))
        : Promise.resolve(opts.cached ?? null),
    analyzeSector: () =>
      opts.sectorReject !== undefined
        ? Promise.reject(opts.sectorReject)
        : Promise.resolve(opts.sectorResult ?? sampleSectorAnalysis),
  } as unknown as TaService;
}

describe('buildTaCell.handler', () => {
  it('golden path returns TaAnalysis', async () => {
    const cell = buildTaCell({ ta: fakeTa({}) });
    const r = await cell.handler({ code: '600519', fresh: false }, ctx);
    expect(r).toEqual(sampleTa);
  });

  it('maps QuantError → validation', async () => {
    const cell = buildTaCell({
      ta: fakeTa({ reject: new QuantError('KLINE_DATA_MISSING', 'no bars', {}) }),
    });
    await expect(cell.handler({ code: '600519', fresh: false }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'validation',
    });
  });

  it('propagates non-QuantError throws', async () => {
    const cell = buildTaCell({ ta: fakeTa({ reject: new Error('net down') }) });
    await expect(cell.handler({ code: '600519', fresh: false }, ctx)).rejects.toThrow('net down');
  });
});

describe('buildTaCell.peek', () => {
  it('cache hit + fresh=false → true', async () => {
    const cell = buildTaCell({ ta: fakeTa({ cached: sampleTa }) });
    expect(await cell.peek!({ code: '600519', fresh: false }, ctx)).toBe(true);
  });

  it('fresh=true → false', async () => {
    const cell = buildTaCell({ ta: fakeTa({ cached: sampleTa }) });
    expect(await cell.peek!({ code: '600519', fresh: true }, ctx)).toBe(false);
  });

  it('cache miss → false', async () => {
    const cell = buildTaCell({ ta: fakeTa({ cached: null }) });
    expect(await cell.peek!({ code: '600519', fresh: false }, ctx)).toBe(false);
  });

  it('getCached throw → false (fail closed)', async () => {
    const cell = buildTaCell({ ta: fakeTa({ cachedThrows: true }) });
    expect(await cell.peek!({ code: '600519', fresh: false }, ctx)).toBe(false);
  });

  it('invalid args → false', async () => {
    const cell = buildTaCell({ ta: fakeTa({ cached: sampleTa }) });
    expect(await cell.peek!({ /* missing code */ }, ctx)).toBe(false);
  });
});

describe('renderTa / formatTaAnalysis', () => {
  it('renders head + trend + support + resistance', () => {
    const out = renderTa({ ok: true, data: sampleTa });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('600519');
    expect(out.output.text).toContain('趋势: ↑ up');
    expect(out.output.text).toContain('置信度=72%');
    expect(out.output.text).toContain('支撑: 1700 / 1650');
    expect(out.output.text).toContain('阻力: 1850');
  });

  it('skips support/resistance lines when empty', () => {
    const out = formatTaAnalysis({
      ...sampleTa,
      supportLevels: [],
      resistanceLevels: [],
    });
    expect(out).not.toContain('支撑:');
    expect(out).not.toContain('阻力:');
  });

  it('passes error envelope through', () => {
    const out = renderTa({ ok: false, error: { code: 'validation', message: 'no bars' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('validation');
  });
});

// ── /ta.sector ──────────────────────────────────────────────────────────

function fakeSectors(opts: {
  readonly resolved?: { id: string; name: string; codes: readonly string[] };
  readonly resolveError?: Error;
}): SectorsService {
  return {
    resolveVisible: () => {
      if (opts.resolveError !== undefined) throw opts.resolveError;
      return opts.resolved ?? { id: 's1', name: 'tech', codes: ['600519'] };
    },
  } as unknown as SectorsService;
}

describe('buildTaSectorCell.handler', () => {
  it('golden path returns { sectorId, sectorName, analysis }', async () => {
    const cell = buildTaSectorCell({ ta: fakeTa({}), sectors: fakeSectors({}) });
    const r = await cell.handler({ id: 's1', fresh: false }, ctx);
    expect(r).toEqual<TaSectorResult>({
      sectorId: 's1',
      sectorName: 'tech',
      analysis: sampleSectorAnalysis,
    });
  });

  it('maps QuantError(NOT_FOUND) on resolveVisible → not-found', async () => {
    const cell = buildTaSectorCell({
      ta: fakeTa({}),
      sectors: fakeSectors({
        resolveError: new QuantError('NOT_FOUND', 'no such sector', {}),
      }),
    });
    await expect(cell.handler({ id: 'ghost', fresh: false }, ctx)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('rejects empty sector with validation', async () => {
    const cell = buildTaSectorCell({
      ta: fakeTa({}),
      sectors: fakeSectors({ resolved: { id: 's1', name: 'empty', codes: [] } }),
    });
    await expect(cell.handler({ id: 's1', fresh: false }, ctx)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('rejects oversized sector with validation', async () => {
    const cell = buildTaSectorCell({
      ta: fakeTa({}),
      sectors: fakeSectors({
        resolved: {
          id: 's1',
          name: 'huge',
          codes: Array.from({ length: 51 }, (_, i) => String(600000 + i)),
        },
      }),
    });
    await expect(cell.handler({ id: 's1', fresh: false }, ctx)).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('maps QuantError from analyzeSector → handler', async () => {
    const cell = buildTaSectorCell({
      ta: fakeTa({ sectorReject: new QuantError('LLM_FAILED', 'quota', {}) }),
      sectors: fakeSectors({}),
    });
    await expect(cell.handler({ id: 's1', fresh: false }, ctx)).rejects.toMatchObject({
      code: 'handler',
    });
  });

  it('has no peek hook (sector aggregate is cache-less)', () => {
    const cell = buildTaSectorCell({ ta: fakeTa({}), sectors: fakeSectors({}) });
    expect(cell.peek).toBeUndefined();
  });
});

describe('renderTaSector / formatSectorAnalysis', () => {
  function okEnv(d: TaSectorResult): InstructionEnvelope<TaSectorResult> {
    return { ok: true, data: d };
  }

  it('renders head + breakdown + summary', () => {
    const out = renderTaSector(
      okEnv({ sectorId: 's1', sectorName: 'tech', analysis: sampleSectorAnalysis }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('s1  tech  members=1');
    expect(out.output.text).toContain('整体: ↑ 多头');
    expect(out.output.text).toContain('板块整体偏多');
  });

  it('emits caveats when present', () => {
    const out = formatSectorAnalysis('s1', 'tech', {
      ...sampleSectorAnalysis,
      caveats: ['600001 failed'],
    });
    expect(out).toContain('⚠ caveats: 600001 failed');
  });

  it('passes error envelope through', () => {
    const out = renderTaSector({
      ok: false,
      error: { code: 'not-found', message: 'gone' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('not-found');
  });
});
