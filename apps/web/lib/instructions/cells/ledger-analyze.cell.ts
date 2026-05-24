/**
 * FE `/ledger.analyze` cell — thin proxy to BE LLM-backed analysis.
 *
 * Renderer mirrors the IM `formatLedgerAnalysis` layout: header line
 * followed by core metrics, behavioral profile, market phases and
 * systemic interventions.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type LedgerAnalyzeResult = ResultOf<'ledger.analyze'>;

const MAX_BREACHES = 3;
const MAX_PHASES = 4;
const MAX_INTERVENTIONS = 3;

export function buildLedgerAnalyzeCell(): InstructionCell<FeEnv, 'ledger.analyze'> {
  return {
    async handler(args, ctx): Promise<LedgerAnalyzeResult> {
      const env = await ctx.api.invoke('ledger.analyze', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      return textOk(formatAnalysis(envelope.data));
    },
  };
}

function formatAnalysis(a: LedgerAnalyzeResult): string {
  const cm = a.coreMetrics;
  const bp = a.behavioralProfiling;
  const lines: string[] = [];
  lines.push(
    paint(
      `ledger analysis  ${a.windowStart} → ${a.windowEnd}  (${String(a.entryCount)} entries, ${a.provider.length > 0 ? a.provider : 'unknown'})`,
      ANSI.bold,
      ANSI.cyan,
    ),
  );
  lines.push('');
  lines.push(paint('core metrics:', ANSI.bold));
  lines.push(`  win rate         : ${fmtPct(cm.winRatePct)}`);
  lines.push(`  pnl ratio        : ${fmtNumOrNa(cm.pnlRatio)}`);
  lines.push(
    `  max drawdown     : ${fmtPct(cm.maxDrawdown.valuePct)}  (${cm.maxDrawdown.startDate} → ${cm.maxDrawdown.endDate})`,
  );
  lines.push(
    `  profit concent.  : ${cm.profitConcentration.level}  core=${cm.profitConcentration.corePeriod}  contrib=${fmtPct(cm.profitConcentration.contributionPct)}`,
  );
  lines.push(`  net cash flow    : ${cm.netCashFlow.status}  ${cm.netCashFlow.amount}`);
  lines.push('');
  lines.push(paint('behavioral profile:', ANSI.bold));
  lines.push(`  pattern    : ${bp.patternDependency}`);
  lines.push(`  emotion    : ${bp.emotionalVolatility}`);
  const breaches = bp.disciplineBreaches.slice(0, MAX_BREACHES);
  if (breaches.length > 0) {
    lines.push(`  breaches:`);
    for (const b of breaches) {
      lines.push(`    ${b.date}  ${fmtPct(b.pnlPct)}  ${b.analysis}`);
    }
    if (bp.disciplineBreaches.length > MAX_BREACHES) {
      lines.push(`    …(+${String(bp.disciplineBreaches.length - MAX_BREACHES)} more)`);
    }
  }
  const phases = a.marketMicrostructure.slice(0, MAX_PHASES);
  if (phases.length > 0) {
    lines.push('');
    lines.push(paint('market microstructure:', ANSI.bold));
    for (const p of phases) lines.push(`  [${p.timeframe}]  ${p.environment}`);
  }
  const interventions = a.systemicInterventions.slice(0, MAX_INTERVENTIONS);
  if (interventions.length > 0) {
    lines.push('');
    lines.push(paint('systemic interventions:', ANSI.bold));
    for (const iv of interventions) {
      lines.push(`  ${paint(iv.command, ANSI.yellow)}  if(${iv.condition}) → ${iv.action}`);
      lines.push(`    why: ${iv.rationale}`);
    }
  }
  return lines.join('\n');
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function fmtNumOrNa(n: number | null): string {
  return n === null ? 'n/a' : n.toFixed(2);
}
