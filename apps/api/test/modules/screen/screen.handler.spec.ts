import { instructionId, QuantError, type NlScreenResult } from '@quant/shared';

import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import { ScreenInstructionHandler } from '../../../src/modules/screen/instructions/screen.handler.js';
import type { ScreenService } from '../../../src/modules/screen/screen.service.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';

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
  // Stub the snapshot service so the table formatter falls back to the
  // bare comma-separated code list — these unit tests cover handler
  // shape, not table rendering (covered by format-stock-table.spec).
  const stockMeta: Pick<StockMetaService, 'snapshotAll'> = {
    snapshotAll: () => Promise.reject(new Error('no snapshot in unit test')),
  };
  return new ScreenInstructionHandler(
    reg,
    screen as unknown as ScreenService,
    stockMeta as unknown as StockMetaService,
  );
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
    const r = await handler.execute({ q: 'find ma5 cross', confirm: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('matches=0');
      expect(r.output.text).toContain('(no matches)');
    }
  });

  it('renders the unified stock-table header + truncates past the display cap', async () => {
    const matches = Array.from({ length: 32 }, (_, i) => ({
      code: String(600000 + i).padStart(6, '0'),
      evidence: { score: 0.9 - i * 0.01, name: `n${String(i)}` },
    }));
    const handler = build({ resolve: { ...baseAst, matches } });
    const r = await handler.execute({ q: 'top picks', confirm: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('matches=32');
      expect(r.output.text).toContain('600000');
      expect(r.output.text).toContain('600029');
      // Snapshot fetch is stubbed to fail → fallback bare-list path,
      // and the cap message reports how many matches were dropped.
      expect(r.output.text).toContain('(+2 more)');
    }
  });

  it('translates QuantError into errResult code=handler', async () => {
    const handler = build({
      reject: new QuantError('NL_TRANSLATION_FAILED', 'llm down', { nl: 'x' }),
    });
    const r = await handler.execute({ q: 'x', confirm: false }, ctx);
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
