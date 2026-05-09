import { instructionId, QuantError, type NlScreenResult } from '@quant/shared';

import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import { ScreenInstructionHandler } from '../../../src/modules/screen/instructions/screen.handler.js';
import type { ScreenService } from '../../../src/modules/screen/screen.service.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'feishu:ou_a' };

function build(opts: { resolve?: NlScreenResult; reject?: Error }): ScreenInstructionHandler {
  const reg = new InstructionRegistry();
  const screen: Pick<ScreenService, 'runNl'> = {
    runNl: () => {
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      if (opts.resolve === undefined) return Promise.reject(new Error('misconfigured'));
      return Promise.resolve(opts.resolve);
    },
  };
  return new ScreenInstructionHandler(reg, screen as unknown as ScreenService);
}

const baseAst: NlScreenResult = {
  nl: 'find ma5 cross',
  asof: '2026-05-09',
  screenPlan: {
    asof: '2026-05-09',
    expr: {
      kind: 'compare',
      op: 'gt',
      left: { kind: 'field', field: 'close' },
      right: { kind: 'const', value: '0' },
    },
  },
  universePlan: null,
  rank: null,
  matches: [],
  planSignature: 'sig-x',
};

describe('ScreenInstructionHandler', () => {
  it('declares spec id `screen` with mode=async', () => {
    const handler = build({ resolve: baseAst });
    expect(handler.spec.id).toBe(instructionId('screen'));
    expect(handler.spec.mode).toBe('async');
  });

  it('renders no-match output when matches is empty', async () => {
    const handler = build({ resolve: baseAst });
    const r = await handler.execute({ q: 'find ma5 cross' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('matches=0');
      expect(r.output.text).toContain('(no matches)');
    }
  });

  it('renders the top N matches with evidence chips', async () => {
    const matches = Array.from({ length: 12 }, (_, i) => ({
      code: String(600000 + i).padStart(6, '0'),
      evidence: { score: 0.9 - i * 0.01, name: `n${String(i)}` },
    }));
    const handler = build({ resolve: { ...baseAst, matches } });
    const r = await handler.execute({ q: 'top picks' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('matches=12');
      expect(r.output.text).toContain('600000');
      expect(r.output.text).toContain('600009');
      expect(r.output.text).toContain('(+2 more)');
    }
  });

  it('translates QuantError into errResult code=handler', async () => {
    const handler = build({
      reject: new QuantError('NL_TRANSLATION_FAILED', 'llm down', { nl: 'x' }),
    });
    const r = await handler.execute({ q: 'x' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('llm down');
    }
  });

  it('rejects malformed asof through zod', () => {
    const handler = build({ resolve: baseAst });
    const result = handler.spec.argsSchema.safeParse({ q: 'x', asof: 'not-a-date' });
    expect(result.success).toBe(false);
  });
});
