/**
 * Pure rendering for `/analyze` (single-stock sentiment).
 *
 * Sentiment result → head line (`code score target asof`) + theme +
 * driver + optional rumor, joined with the analyst body when present.
 * Output stays inside Feishu's 3000-char card limit because the
 * analyst prompt itself caps body at ≤1000 chars; no handler-side
 * truncation needed.
 */

import {
  okResult,
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
  const score = s.score.toFixed(2);
  const head = [
    `${s.code}  score=${score}  target=${s.target.toFixed(2)}  asof=${s.cachedAt.slice(0, 10)}`,
    `主题: ${s.theme}`,
    `驱动: ${s.driver}`,
    s.rumor.length > 0 ? `传闻: ${s.rumor}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
  const body = s.result.trim();
  if (body.length === 0) return head;
  return `${head}\n\n${body}`;
}
