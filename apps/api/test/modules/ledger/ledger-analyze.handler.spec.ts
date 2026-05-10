import { instructionId, QuantError, type LedgerAnalysis } from '@quant/shared';

import { LedgerAnalyzeInstructionHandler } from '../../../src/modules/ledger/instructions/ledger-analyze.handler.js';
import type { LedgerService } from '../../../src/modules/ledger/ledger.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'feishu:ou_a' };

const baseAnalysis: LedgerAnalysis = {
  summary: 'all good',
  operationStyle: 'swing',
  marketView: 'cautious',
  recommendations: ['hold core', 'cut tail risk', 'watch ma60'],
  generatedAt: '2026-05-09T00:00:00.000Z',
  windowStart: '2026-04-09',
  windowEnd: '2026-05-09',
  entryCount: 21,
  provider: 'moonshot',
};

interface Calls {
  readonly fresh: boolean[];
}

function build(opts: { resolve?: LedgerAnalysis; reject?: Error }): {
  handler: LedgerAnalyzeInstructionHandler;
  calls: Calls;
} {
  const reg = new InstructionRegistry();
  const calls: Calls = { fresh: [] };
  const ledger: Pick<LedgerService, 'analyze'> = {
    analyze: (_userId, _traceId, fresh) => {
      calls.fresh.push(fresh ?? false);
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      if (opts.resolve === undefined) return Promise.reject(new Error('test misconfigured'));
      return Promise.resolve(opts.resolve);
    },
  };
  return {
    handler: new LedgerAnalyzeInstructionHandler(reg, ledger as unknown as LedgerService),
    calls,
  };
}

describe('LedgerAnalyzeInstructionHandler', () => {
  it('declares spec id `ledger.analyze` with mode=async (term-aligned id)', () => {
    const { handler } = build({ resolve: baseAnalysis });
    expect(handler.spec.id).toBe(instructionId('ledger.analyze'));
    expect(handler.spec.mode).toBe('async');
    expect(handler.spec.costsCredits).toBe(true);
  });

  it('returns a condensed text view on success', async () => {
    const { handler } = build({ resolve: baseAnalysis });
    const r = await handler.execute({ fresh: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('ledger analyze  2026-04-09 → 2026-05-09');
      expect(r.output.text).toContain('via=moonshot');
      expect(r.output.text).toContain('summary : all good');
      expect(r.output.text).toContain('1. hold core');
    }
  });

  it('passes the fresh flag through', async () => {
    const { handler, calls } = build({ resolve: baseAnalysis });
    await handler.execute({ fresh: true }, ctx);
    expect(calls.fresh).toEqual([true]);
  });

  it('converts QuantError into errResult code=handler', async () => {
    const { handler } = build({
      reject: new QuantError('LLM_FAILED', 'upstream timed out', {}),
    });
    const r = await handler.execute({ fresh: false }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('upstream timed out');
    }
  });

  it('rethrows unexpected errors so the executor tags them', async () => {
    const { handler } = build({ reject: new Error('weird') });
    await expect(handler.execute({ fresh: false }, ctx)).rejects.toThrow('weird');
  });
});
