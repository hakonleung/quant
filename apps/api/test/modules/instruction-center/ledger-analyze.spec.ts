/**
 * Tests for the /ledger.analyze cell — handler + renderer.
 *
 * Handler:
 *   - golden path returns LedgerAnalysis verbatim
 *   - forwards `fresh` to LedgerService.analyze
 *   - QuantError → handler envelope
 *   - non-QuantError throws propagate
 *
 * Renderer (formatLedgerAnalysis):
 *   - head + summary + style + view + recommendations
 *   - recommendation list capped at MAX_RECS (5) with "+N more" tail
 *   - empty recommendations skip the "recommendations:" block
 *   - error envelope passthrough
 */

import {
  QuantError,
  type InstructionEnvelope,
  type LedgerAnalysis,
  type ResultOf,
} from '@quant/shared';

import { buildLedgerAnalyzeCell } from '../../../src/modules/instruction-center/cells/ledger-analyze.cell.js';
import {
  formatLedgerAnalysis,
  renderLedgerAnalyze,
} from '../../../src/modules/instruction-center/cells/ledger-analyze.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { LedgerService } from '../../../src/modules/ledger/ledger.service.js';

type LedgerAnalyzeResult = ResultOf<'ledger.analyze'>;

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

const sample: LedgerAnalysis = {
  summary: '本月偏防守',
  operationStyle: '波段',
  marketView: '震荡',
  recommendations: ['控制仓位', '关注食品板块'],
  windowStart: '2026-04-01',
  windowEnd: '2026-04-30',
  entryCount: 12,
  provider: 'deepseek',
  generatedAt: '2026-05-01T00:00:00.000Z',
} as LedgerAnalysis;

interface AnalyzeCall {
  userId: string;
  traceId: string;
  fresh: boolean;
}

function fakeLedger(opts: { reject?: Error }): {
  service: LedgerService;
  calls: AnalyzeCall[];
} {
  const calls: AnalyzeCall[] = [];
  const service = {
    analyze: (userId: string, traceId: string, fresh: boolean) => {
      calls.push({ userId, traceId, fresh });
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      return Promise.resolve(sample);
    },
  } as unknown as LedgerService;
  return { service, calls };
}

describe('buildLedgerAnalyzeCell.handler', () => {
  it('golden path returns LedgerAnalysis verbatim and forwards fresh=false', async () => {
    const { service, calls } = fakeLedger({});
    const cell = buildLedgerAnalyzeCell({ ledger: service });
    const r = await cell.handler({ fresh: false }, ctx);
    expect(r).toEqual(sample);
    expect(calls[0]).toEqual({ userId: 'me', traceId: 't1', fresh: false });
  });

  it('forwards fresh=true', async () => {
    const { service, calls } = fakeLedger({});
    const cell = buildLedgerAnalyzeCell({ ledger: service });
    await cell.handler({ fresh: true }, ctx);
    expect(calls[0]?.fresh).toBe(true);
  });

  it('maps QuantError → handler', async () => {
    const cell = buildLedgerAnalyzeCell({
      ledger: fakeLedger({
        reject: new QuantError('LLM_FAILED', 'quota', {}),
      }).service,
    });
    await expect(cell.handler({ fresh: false }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'handler',
    });
  });

  it('propagates non-QuantError throws', async () => {
    const cell = buildLedgerAnalyzeCell({
      ledger: fakeLedger({ reject: new Error('net down') }).service,
    });
    await expect(cell.handler({ fresh: false }, ctx)).rejects.toThrow('net down');
  });
});

describe('renderLedgerAnalyze / formatLedgerAnalysis', () => {
  function okEnv(d: LedgerAnalyzeResult): InstructionEnvelope<LedgerAnalyzeResult> {
    return { ok: true, data: d };
  }

  it('renders head + summary/style/view + recommendations', () => {
    const out = renderLedgerAnalyze(okEnv(sample));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('ledger analyze');
    expect(out.output.text).toContain('2026-04-01 → 2026-04-30');
    expect(out.output.text).toContain('entries=12');
    expect(out.output.text).toContain('via=deepseek');
    expect(out.output.text).toContain('summary : 本月偏防守');
    expect(out.output.text).toContain('style   : 波段');
    expect(out.output.text).toContain('view    : 震荡');
    expect(out.output.text).toContain('1. 控制仓位');
    expect(out.output.text).toContain('2. 关注食品板块');
  });

  it('caps recommendations at 5 with "+N more" tail', () => {
    const many: LedgerAnalysis = {
      ...sample,
      recommendations: Array.from({ length: 8 }, (_, i) => `tip ${String(i + 1)}`),
    };
    const out = formatLedgerAnalysis(many);
    expect(out).toContain('1. tip 1');
    expect(out).toContain('5. tip 5');
    expect(out).not.toContain('6. tip 6');
    expect(out).toContain('+3 more');
  });

  it('skips the "recommendations:" block when empty', () => {
    const empty: LedgerAnalysis = { ...sample, recommendations: [] };
    const out = formatLedgerAnalysis(empty);
    expect(out).not.toContain('recommendations:');
  });

  it('passes through error envelope', () => {
    const out = renderLedgerAnalyze({
      ok: false,
      error: { code: 'handler', message: 'down' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('handler');
  });
});
