/**
 * Pure rendering for `/ledger.analyze`. Renders the diagnostic report
 * as text: core metrics block, behavioral profile, market phase list,
 * and systemic-intervention rules. Each list-style section is capped.
 */

import { okResult, type InstructionEnvelope, type ResultOf } from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type LedgerAnalyzeResult = ResultOf<'ledger.analyze'>;

const MAX_BREACHES = 3;
const MAX_PHASES = 4;
const MAX_INTERVENTIONS = 3;

export function renderLedgerAnalyze(
  envelope: InstructionEnvelope<LedgerAnalyzeResult>,
): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  return okResult(formatLedgerAnalysis(envelope.data));
}

export function formatLedgerAnalysis(a: LedgerAnalyzeResult): string {
  const cm = a.coreMetrics;
  const bp = a.behavioralProfiling;
  const lines: string[] = [
    `ledger analyze  ${a.windowStart} → ${a.windowEnd}  entries=${String(a.entryCount)}  via=${a.provider}`,
    `metrics : win=${fmtPct(cm.winRatePct)}  pnl_ratio=${fmtNumOrNa(cm.pnlRatio)}  mdd=${fmtPct(cm.maxDrawdown.valuePct)} (${cm.maxDrawdown.startDate}→${cm.maxDrawdown.endDate})`,
    `concent.: ${cm.profitConcentration.level}  core=${cm.profitConcentration.corePeriod}  contrib=${fmtPct(cm.profitConcentration.contributionPct)}`,
    `cashflow: ${cm.netCashFlow.status}  amount=${cm.netCashFlow.amount}`,
    `pattern : ${bp.patternDependency}`,
    `emotion : ${bp.emotionalVolatility}`,
  ];
  const breaches = bp.disciplineBreaches.slice(0, MAX_BREACHES);
  if (breaches.length > 0) {
    lines.push('breaches:');
    for (const b of breaches) {
      lines.push(`  ${b.date}  ${fmtPct(b.pnlPct)}  ${b.analysis}`);
    }
    if (bp.disciplineBreaches.length > MAX_BREACHES) {
      lines.push(`  …(+${String(bp.disciplineBreaches.length - MAX_BREACHES)} more)`);
    }
  }
  const phases = a.marketMicrostructure.slice(0, MAX_PHASES);
  if (phases.length > 0) {
    lines.push('phases:');
    for (const p of phases) lines.push(`  [${p.timeframe}] ${p.environment}`);
  }
  const interventions = a.systemicInterventions.slice(0, MAX_INTERVENTIONS);
  if (interventions.length > 0) {
    lines.push('interventions:');
    for (const iv of interventions) {
      lines.push(`  ${iv.command}  if(${iv.condition}) → ${iv.action}`);
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
