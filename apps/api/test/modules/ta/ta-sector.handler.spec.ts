import { instructionId, QuantError, type TaSectorAnalysis, type Sector } from '@quant/shared';

import {
  TaSectorInstructionHandler,
  formatSectorAnalysis,
} from '../../../src/modules/ta/instructions/ta-sector.handler.js';
import type { TaService } from '../../../src/modules/ta/ta.service.js';
import type { SectorsService } from '../../../src/modules/sectors/sectors.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't3', source: 'im', userId: 'feishu:ou_c' };

const baseSector: Sector = {
  id: 's1',
  name: '白酒',
  kind: 'user',
  count: 3,
  meta: '',
  chgPct: null,
  codes: ['600519', '000858', '000568'],
  createdBy: 'feishu:ou_c',
  published: false,
};

const baseSectorAnalysis: TaSectorAnalysis = {
  codes: ['600519', '000858', '000568'],
  trendBreakdown: { up: 2, down: 1, sideways: 0 },
  overallDirection: 'up',
  overallConfidence: 0.75,
  members: [],
  summary: '白酒板块整体偏多',
  caveats: [],
  cachedAt: '2026-05-06T10:00:00.000+00:00',
};

function build(opts: {
  sector?: Sector;
  sectorError?: Error;
  analysisResolve?: TaSectorAnalysis;
  analysisReject?: Error;
}): { handler: TaSectorInstructionHandler } {
  const reg = new InstructionRegistry();
  const sectors: Pick<SectorsService, 'resolveVisible'> = {
    resolveVisible: jest.fn().mockImplementation(() => {
      if (opts.sectorError !== undefined) throw opts.sectorError;
      return opts.sector ?? baseSector;
    }),
  };
  const ta: Pick<TaService, 'analyzeSector'> = {
    analyzeSector: jest.fn().mockImplementation(() => {
      if (opts.analysisReject !== undefined) return Promise.reject(opts.analysisReject);
      return Promise.resolve(opts.analysisResolve ?? baseSectorAnalysis);
    }),
  };
  return {
    handler: new TaSectorInstructionHandler(
      reg,
      ta as unknown as TaService,
      sectors as unknown as SectorsService,
    ),
  };
}

describe('TaSectorInstructionHandler', () => {
  it('declares spec id `ta.sector` mode=async costsCredits=true', () => {
    const { handler } = build({});
    expect(handler.spec.id).toBe(instructionId('ta.sector'));
    expect(handler.spec.mode).toBe('async');
    expect(handler.spec.costsCredits).toBe(true);
  });

  it('golden path renders members count, direction label, and summary', async () => {
    const { handler } = build({ analysisResolve: baseSectorAnalysis });
    const r = await handler.execute({ id: 's1', fresh: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('s1');
      expect(r.output.text).toContain('白酒');
      expect(r.output.text).toContain('members=0');
      expect(r.output.text).toContain('↑ 多头');
      expect(r.output.text).toContain('75%');
      expect(r.output.text).toContain('白酒板块整体偏多');
    }
  });

  it('returns errResult not-found when sector is NOT_FOUND', async () => {
    const { handler } = build({
      sectorError: new QuantError('NOT_FOUND', 'sector s99 not found', {}),
    });
    const r = await handler.execute({ id: 's99', fresh: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('not-found');
      expect(r.error.message).toContain('sector s99');
    }
  });

  it('returns errResult validation when sector has no member codes', async () => {
    const { handler } = build({ sector: { ...baseSector, codes: [] } });
    const r = await handler.execute({ id: 's1', fresh: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toContain('no member codes');
    }
  });

  it('returns errResult validation when sector exceeds 50 codes', async () => {
    const manyCodes = Array.from({ length: 51 }, (_, i) => String(i).padStart(6, '0'));
    const { handler } = build({ sector: { ...baseSector, codes: manyCodes } });
    const r = await handler.execute({ id: 's1', fresh: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toContain('max 50');
    }
  });

  it('converts QuantError from analyzeSector into errResult code=handler', async () => {
    const { handler } = build({
      analysisReject: new QuantError('LLM_FAILED', 'llm timeout', {}),
    });
    const r = await handler.execute({ id: 's1', fresh: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('llm timeout');
    }
  });

  it('rethrows non-QuantError from analyzeSector', async () => {
    const { handler } = build({ analysisReject: new Error('unexpected crash') });
    await expect(handler.execute({ id: 's1', fresh: false }, ctx)).rejects.toThrow(
      'unexpected crash',
    );
  });

  it('rethrows non-QuantError from resolveVisible', async () => {
    const { handler } = build({ sectorError: new Error('store corrupted') });
    await expect(handler.execute({ id: 's1', fresh: false }, ctx)).rejects.toThrow(
      'store corrupted',
    );
  });

  describe('formatSectorAnalysis', () => {
    it('renders caveats block when present', () => {
      const a: TaSectorAnalysis = { ...baseSectorAnalysis, caveats: ['数据不足', '部分停牌'] };
      const out = formatSectorAnalysis('s1', '白酒', a);
      expect(out).toContain('caveats:');
      expect(out).toContain('数据不足');
    });

    it('omits caveats block when empty', () => {
      const a: TaSectorAnalysis = { ...baseSectorAnalysis, caveats: [] };
      const out = formatSectorAnalysis('s1', '白酒', a);
      expect(out).not.toContain('caveats:');
    });

    it('renders down label for overall bearish direction', () => {
      const a: TaSectorAnalysis = { ...baseSectorAnalysis, overallDirection: 'down' };
      expect(formatSectorAnalysis('s2', '科技', a)).toContain('↓ 空头');
    });
  });
});
