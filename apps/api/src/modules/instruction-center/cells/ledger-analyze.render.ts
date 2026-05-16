/**
 * Pure rendering for `/ledger.analyze`. Caps the displayed
 * recommendations at `MAX_RECS` with a "+N more" tail; output text
 * matches the legacy `formatLedgerAnalysis` exactly.
 */

import {
  okResult,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type LedgerAnalyzeResult = ResultOf<'ledger.analyze'>;

const MAX_RECS = 5;

export function renderLedgerAnalyze(
  envelope: InstructionEnvelope<LedgerAnalyzeResult>,
): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  return okResult(formatLedgerAnalysis(envelope.data));
}

export function formatLedgerAnalysis(a: LedgerAnalyzeResult): string {
  const recs = a.recommendations.slice(0, MAX_RECS);
  const lines = [
    `ledger analyze  ${a.windowStart} → ${a.windowEnd}  entries=${String(a.entryCount)}  via=${a.provider}`,
    `summary : ${a.summary}`,
    `style   : ${a.operationStyle}`,
    `view    : ${a.marketView}`,
  ];
  if (recs.length > 0) {
    lines.push(`recommendations:`);
    recs.forEach((r, i) => lines.push(`  ${String(i + 1)}. ${r}`));
    if (a.recommendations.length > MAX_RECS) {
      lines.push(`  …(+${String(a.recommendations.length - MAX_RECS)} more)`);
    }
  }
  return lines.join('\n');
}
