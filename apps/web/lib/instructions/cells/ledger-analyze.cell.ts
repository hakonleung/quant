/**
 * FE `/ledger.analyze` cell — thin proxy to BE LLM-backed analysis.
 *
 * Renderer mirrors the legacy `formatAnalysis` shape: header line,
 * sections for summary / operationStyle / marketView, numbered
 * recommendations.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type LedgerAnalyzeResult = ResultOf<'ledger.analyze'>;

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
  const lines: string[] = [];
  lines.push(
    paint(
      `ledger analysis  ${a.windowStart} → ${a.windowEnd}  (${String(a.entryCount)} entries, ${a.provider.length > 0 ? a.provider : 'unknown'})`,
      ANSI.bold,
      ANSI.cyan,
    ),
  );
  lines.push('');
  lines.push(paint('summary:', ANSI.bold));
  lines.push(`  ${a.summary}`);
  lines.push('');
  lines.push(paint('operation style:', ANSI.bold));
  lines.push(`  ${a.operationStyle}`);
  lines.push('');
  lines.push(paint('market view:', ANSI.bold));
  lines.push(`  ${a.marketView}`);
  if (a.recommendations.length > 0) {
    lines.push('');
    lines.push(paint('recommendations:', ANSI.bold));
    for (const [i, r] of a.recommendations.entries()) {
      lines.push(`  ${String(i + 1)}. ${r}`);
    }
  }
  return lines.join('\n');
}
