import { instructionId, QuantError, type MarketSentiment, type Sector } from '@quant/shared';

import {
  AnalyzeSectorInstructionHandler,
  formatMarketSentiment,
} from '../../../src/modules/sentiment/instructions/analyze-sector.handler.js';
import type { NewsSentimentService } from '../../../src/modules/sentiment/news-sentiment.service.js';
import type { SectorsService } from '../../../src/modules/sectors/sectors.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't5', source: 'im', userId: 'feishu:ou_e' };

const baseSector: Sector = {
  id: 's2',
  name: '新能源',
  kind: 'user',
  count: 2,
  meta: '',
  chgPct: null,
  codes: ['300750', '002594'],
  createdBy: 'feishu:ou_e',
  published: false,
};

const baseMarketSentiment: MarketSentiment = {
  asof: '2026-05-06',
  windowDays: 7,
  fetchedAt: '2026-05-06T10:00:00.000+00:00',
  codeHash: 'abc123',
  codes: ['300750', '002594'],
  themeClusters: [
    { label: '补贴政策预期', memberCount: 2, heatScore: 0.85, summary: '政策催化强' },
  ],
  marketTrendSummary: '新能源板块情绪偏乐观，整体多头',
  caveats: [],
};

function build(opts: {
  sector?: Sector;
  sectorError?: Error;
  marketResolve?: MarketSentiment;
  marketReject?: Error;
}): { handler: AnalyzeSectorInstructionHandler } {
  const reg = new InstructionRegistry();
  const sectors: Pick<SectorsService, 'resolveVisible'> = {
    resolveVisible: jest.fn().mockImplementation(() => {
      if (opts.sectorError !== undefined) throw opts.sectorError;
      return opts.sector ?? baseSector;
    }),
  };
  const sentiment: Pick<NewsSentimentService, 'analyzeMany'> = {
    analyzeMany: jest.fn().mockImplementation(() => {
      if (opts.marketReject !== undefined) return Promise.reject(opts.marketReject);
      return Promise.resolve(opts.marketResolve ?? baseMarketSentiment);
    }),
  };
  return {
    handler: new AnalyzeSectorInstructionHandler(
      reg,
      sentiment as unknown as NewsSentimentService,
      sectors as unknown as SectorsService,
    ),
  };
}

describe('AnalyzeSectorInstructionHandler', () => {
  it('declares spec id `analyze.sector` mode=async costsCredits=true', () => {
    const { handler } = build({});
    expect(handler.spec.id).toBe(instructionId('analyze.sector'));
    expect(handler.spec.mode).toBe('async');
    expect(handler.spec.costsCredits).toBe(true);
  });

  it('golden path renders sector header, theme clusters, and market trend summary', async () => {
    const { handler } = build({});
    const r = await handler.execute({ id: 's2', fresh: false, confirm: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('s2');
      expect(r.output.text).toContain('新能源');
      expect(r.output.text).toContain('members=2');
      expect(r.output.text).toContain('主题聚类:');
      expect(r.output.text).toContain('补贴政策预期');
      expect(r.output.text).toContain('新能源板块情绪偏乐观');
    }
  });

  it('returns errResult not-found when sector is NOT_FOUND', async () => {
    const { handler } = build({
      sectorError: new QuantError('NOT_FOUND', 'sector s99 not found', {}),
    });
    const r = await handler.execute({ id: 's99', fresh: false, confirm: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('not-found');
    }
  });

  it('returns errResult validation when sector has no codes', async () => {
    const { handler } = build({ sector: { ...baseSector, codes: [] } });
    const r = await handler.execute({ id: 's2', fresh: false, confirm: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toContain('no member codes');
    }
  });

  it('returns errResult validation when sector exceeds 50 codes', async () => {
    const manyCodes = Array.from({ length: 51 }, (_, i) => String(i).padStart(6, '0'));
    const { handler } = build({ sector: { ...baseSector, codes: manyCodes } });
    const r = await handler.execute({ id: 's2', fresh: false, confirm: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toContain('max 50');
    }
  });

  it('converts QuantError from analyzeMany into errResult code=handler', async () => {
    const { handler } = build({
      marketReject: new QuantError('LLM_FAILED', 'quota exceeded', {}),
    });
    const r = await handler.execute({ id: 's2', fresh: false, confirm: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('quota exceeded');
    }
  });

  it('rethrows non-QuantError from analyzeMany', async () => {
    const { handler } = build({ marketReject: new Error('rpc down') });
    await expect(handler.execute({ id: 's2', fresh: false, confirm: false }, ctx)).rejects.toThrow('rpc down');
  });

  describe('formatMarketSentiment', () => {
    it('omits theme cluster block when empty', () => {
      const m: MarketSentiment = { ...baseMarketSentiment, themeClusters: [] };
      const out = formatMarketSentiment('s2', '新能源', m);
      expect(out).not.toContain('主题聚类:');
    });

    it('renders caveats block when present', () => {
      const m: MarketSentiment = { ...baseMarketSentiment, caveats: ['数据缺口'] };
      const out = formatMarketSentiment('s2', '新能源', m);
      expect(out).toContain('caveats: 数据缺口');
    });
  });
});
