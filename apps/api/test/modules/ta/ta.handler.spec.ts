import { instructionId, QuantError, type TaAnalysis } from '@quant/shared';

import { TaInstructionHandler, formatTaAnalysis } from '../../../src/modules/ta/instructions/ta.handler.js';
import type { TaService } from '../../../src/modules/ta/ta.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'feishu:ou_a' };

const baseAnalysis: TaAnalysis = {
  code: '600519',
  asof: '2026-05-06',
  barsCount: 90,
  supportLevels: [{ price: '1500.00', strength: 'strong', reason: 'MA60 + 前低密集成交区' }],
  resistanceLevels: [{ price: '1800.00', strength: 'medium', reason: '上方筹码峰' }],
  trend: { direction: 'up', horizonDays: 10, confidence: 0.7, rationale: 'MA 多头排列' },
  patterns: ['上升三角形整理'],
  caveats: [],
  provider: 'moonshot',
  cachedAt: '2026-05-06T08:00:00.000+00:00',
};

function build(opts: { resolve?: TaAnalysis; reject?: Error }): {
  handler: TaInstructionHandler;
  calls: { code: string[]; fresh: boolean[] };
} {
  const reg = new InstructionRegistry();
  const calls = { code: [] as string[], fresh: [] as boolean[] };
  const ta: Pick<TaService, 'analyzeOne'> = {
    analyzeOne: jest.fn().mockImplementation((code: string, fresh: boolean) => {
      calls.code.push(code);
      calls.fresh.push(fresh);
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      if (opts.resolve === undefined) return Promise.reject(new Error('test misconfigured'));
      return Promise.resolve(opts.resolve);
    }),
  };
  return { handler: new TaInstructionHandler(reg, ta as unknown as TaService), calls };
}

describe('TaInstructionHandler', () => {
  it('declares spec id `ta` mode=async costsCredits=true with imAliases', () => {
    const { handler } = build({ resolve: baseAnalysis });
    expect(handler.spec.id).toBe(instructionId('ta'));
    expect(handler.spec.mode).toBe('async');
    expect(handler.spec.costsCredits).toBe(true);
    expect(handler.spec.imAliases).toEqual(['技术', '走势', '技分']);
  });

  it('golden path returns formatted analysis with direction emoji and confidence', async () => {
    const { handler } = build({ resolve: baseAnalysis });
    const r = await handler.execute({ code: '600519', fresh: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('600519');
      expect(r.output.text).toContain('↑');
      expect(r.output.text).toContain('70%');
      expect(r.output.text).toContain('1500.00');
      expect(r.output.text).toContain('1800.00');
    }
  });

  it('passes code and fresh flag through to TaService', async () => {
    const { handler, calls } = build({ resolve: baseAnalysis });
    await handler.execute({ code: '600519', fresh: true }, ctx);
    expect(calls.code).toEqual(['600519']);
    expect(calls.fresh).toEqual([true]);
  });

  it('fresh defaults to false when not supplied', async () => {
    const { handler, calls } = build({ resolve: baseAnalysis });
    await handler.execute({ code: '000001', fresh: false }, ctx);
    expect(calls.fresh).toEqual([false]);
  });

  it('converts QuantError into errResult code=validation', async () => {
    const { handler } = build({
      reject: new QuantError('LLM_FAILED', 'upstream timed out', {}),
    });
    const r = await handler.execute({ code: '600519', fresh: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toBe('upstream timed out');
    }
  });

  it('rethrows non-QuantError so the executor tags them', async () => {
    const { handler } = build({ reject: new Error('weird') });
    await expect(handler.execute({ code: '600519', fresh: false }, ctx)).rejects.toThrow('weird');
  });

  describe('formatTaAnalysis', () => {
    it('renders down emoji for bearish trend', () => {
      const a: TaAnalysis = { ...baseAnalysis, trend: { ...baseAnalysis.trend, direction: 'down', confidence: 0.5 } };
      expect(formatTaAnalysis(a)).toContain('↓');
      expect(formatTaAnalysis(a)).toContain('50%');
    });

    it('renders sideways emoji for sideways trend', () => {
      const a: TaAnalysis = { ...baseAnalysis, trend: { ...baseAnalysis.trend, direction: 'sideways' }, supportLevels: [], resistanceLevels: [] };
      const out = formatTaAnalysis(a);
      expect(out).toContain('→');
      expect(out).not.toContain('支撑:');
      expect(out).not.toContain('阻力:');
    });

    it('omits support and resistance lines when arrays are empty', () => {
      const a: TaAnalysis = { ...baseAnalysis, supportLevels: [], resistanceLevels: [] };
      const out = formatTaAnalysis(a);
      expect(out).not.toContain('支撑:');
      expect(out).not.toContain('阻力:');
    });
  });
});
