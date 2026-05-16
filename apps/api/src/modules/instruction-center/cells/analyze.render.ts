/**
 * Pure rendering for `/analyze` (single-stock sentiment).
 *
 * Head line carries score + cached date; brief paragraph is rendered
 * standalone; full multi-section breakdown comes from
 * `sentimentLines()` in `@quant/shared/fp`. Both IM and FE consume the
 * same formatter — no duplicated rendering logic.
 */

import {
  okResult,
  sentimentLines,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type AnalyzeResult = ResultOf<'analyze'>;

export function renderAnalyze(envelope: InstructionEnvelope<AnalyzeResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  return okResult(formatSentiment(envelope.data));
}

export function formatSentiment(s: AnalyzeResult): string {
  const head = `${s.code}  score=${s.score.toFixed(2)}  asof=${s.cachedAt.slice(0, 10)}`;
  const briefBlock = s.brief.length > 0 ? `\n\n${s.brief}` : '';
  const detail = sentimentLines(s).join('\n');
  return `${head}${briefBlock}\n\n${detail}`;
}
