import { instructionId, type TaAnalysis } from '@quant/shared';

import { TaShowInstructionHandler } from '../../../src/modules/ta/instructions/ta-show.handler.js';
import type { TaService } from '../../../src/modules/ta/ta.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't2', source: 'im', userId: 'feishu:ou_b' };

const cachedAnalysis: TaAnalysis = {
  code: '000001',
  asof: '2026-05-06',
  barsCount: 60,
  supportLevels: [{ price: '12.00', strength: 'medium', reason: 'MA20 支撑' }],
  resistanceLevels: [],
  trend: { direction: 'sideways', horizonDays: 5, confidence: 0.55, rationale: '区间震荡' },
  patterns: [],
  caveats: [],
  provider: 'deepseek',
  cachedAt: '2026-05-06T10:00:00.000+00:00',
};

function build(opts: { cached: TaAnalysis | null }): { handler: TaShowInstructionHandler } {
  const reg = new InstructionRegistry();
  const ta: Pick<TaService, 'getCached'> = {
    getCached: jest.fn().mockResolvedValue(opts.cached),
  };
  return { handler: new TaShowInstructionHandler(reg, ta as unknown as TaService) };
}

describe('TaShowInstructionHandler', () => {
  it('declares spec id `ta.show` with costsCredits=true', () => {
    const { handler } = build({ cached: null });
    expect(handler.spec.id).toBe(instructionId('ta.show'));
    expect(handler.spec.costsCredits).toBe(true);
  });

  it('golden path returns formatted analysis when cache is populated', async () => {
    const { handler } = build({ cached: cachedAnalysis });
    const r = await handler.execute({ code: '000001' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('000001');
      expect(r.output.text).toContain('→');
    }
  });

  it('returns ok with guidance text when cache is empty', async () => {
    const { handler } = build({ cached: null });
    const r = await handler.execute({ code: '600519' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('no cached analysis for 600519');
      expect(r.output.text).toContain('ta 600519');
    }
  });

  it('mode is not async (synchronous cache read)', () => {
    const { handler } = build({ cached: null });
    expect(handler.spec.mode).toBeUndefined();
  });
});
