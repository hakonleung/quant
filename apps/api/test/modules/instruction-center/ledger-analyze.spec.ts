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
 *   - header + core metrics + behavioral + phases + interventions
 *   - sections cap with "+N more" tails where applicable
 *   - sections omitted when their lists are empty
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
  coreMetrics: {
    winRatePct: 65.5,
    pnlRatio: 1.8,
    maxDrawdown: { valuePct: -12.3, startDate: '2026-04-10', endDate: '2026-04-22' },
    profitConcentration: { level: 'high', corePeriod: '4.11-4.13', contributionPct: 78 },
    netCashFlow: { status: 'inflow', amount: '5000' },
  },
  behavioralProfiling: {
    patternDependency: '极度依赖趋势跟随',
    disciplineBreaches: [{ date: '2026-04-15', pnlPct: -5.2, analysis: '扛单' }],
    emotionalVolatility: '末期重仓博弈',
  },
  marketMicrostructure: [{ timeframe: '4.11-4.13', environment: '强主线顺风期' }],
  systemicInterventions: [
    {
      command: 'SET_MAX_DRAWDOWN_LIMIT',
      condition: 'WIN_STREAK >= 5',
      action: 'HALT_TRADING_24H',
      rationale: '连胜后情绪化',
    },
  ],
  windowStart: '2026-04-01',
  windowEnd: '2026-04-30',
  entryCount: 12,
  provider: 'deepseek',
  generatedAt: '2026-05-01T00:00:00.000Z',
};

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

  it('renders header + metrics + behavioral + phases + interventions', () => {
    const out = renderLedgerAnalyze(okEnv(sample));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const text = out.output.text;
    expect(text).toContain('ledger analyze');
    expect(text).toContain('2026-04-01 → 2026-04-30');
    expect(text).toContain('entries=12');
    expect(text).toContain('via=deepseek');
    expect(text).toContain('win=65.50%');
    expect(text).toContain('pnl_ratio=1.80');
    expect(text).toContain('mdd=-12.30%');
    expect(text).toContain('high');
    expect(text).toContain('4.11-4.13');
    expect(text).toContain('inflow');
    expect(text).toContain('极度依赖趋势跟随');
    expect(text).toContain('末期重仓博弈');
    expect(text).toContain('breaches:');
    expect(text).toContain('2026-04-15  -5.20%  扛单');
    expect(text).toContain('phases:');
    expect(text).toContain('[4.11-4.13] 强主线顺风期');
    expect(text).toContain('interventions:');
    expect(text).toContain('SET_MAX_DRAWDOWN_LIMIT');
    expect(text).toContain('if(WIN_STREAK >= 5) → HALT_TRADING_24H');
    expect(text).toContain('why: 连胜后情绪化');
  });

  it('caps breaches at 3 with "+N more" tail', () => {
    const many: LedgerAnalysis = {
      ...sample,
      behavioralProfiling: {
        ...sample.behavioralProfiling,
        disciplineBreaches: Array.from({ length: 5 }, (_, i) => ({
          date: `2026-04-${String(10 + i).padStart(2, '0')}`,
          pnlPct: -1 - i,
          analysis: `b${String(i)}`,
        })),
      },
    };
    const out = formatLedgerAnalysis(many);
    expect(out).toContain('b0');
    expect(out).toContain('b2');
    expect(out).not.toContain('b3');
    expect(out).toContain('+2 more');
  });

  it('omits sections when their lists are empty', () => {
    const empty: LedgerAnalysis = {
      ...sample,
      behavioralProfiling: { ...sample.behavioralProfiling, disciplineBreaches: [] },
      marketMicrostructure: [],
      systemicInterventions: [],
    };
    const out = formatLedgerAnalysis(empty);
    expect(out).not.toContain('breaches:');
    expect(out).not.toContain('phases:');
    expect(out).not.toContain('interventions:');
  });

  it('renders pnl_ratio=n/a when null', () => {
    const noRatio: LedgerAnalysis = {
      ...sample,
      coreMetrics: { ...sample.coreMetrics, pnlRatio: null },
    };
    const out = formatLedgerAnalysis(noRatio);
    expect(out).toContain('pnl_ratio=n/a');
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
