/**
 * Pure rendering for `/ta` and `/ta.sector`. Per-instruction renderers
 * share the same direction-emoji table to keep wording consistent
 * across the IM/term surfaces.
 */

import {
  okResult,
  type InstructionEnvelope,
  type TaResult,
  type TaSectorResult,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

const DIR_EMOJI: Readonly<Record<'up' | 'down' | 'sideways', string>> = {
  up: '↑',
  down: '↓',
  sideways: '→',
};

const SECTOR_DIR_LABEL: Readonly<Record<'up' | 'down' | 'sideways', string>> = {
  up: '↑ 多头',
  down: '↓ 空头',
  sideways: '→ 震荡',
};

export function renderTa(envelope: InstructionEnvelope<TaResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  return okResult(formatTaAnalysis(envelope.data));
}

export function formatTaAnalysis(a: TaResult): string {
  const pct = (a.trend.confidence * 100).toFixed(0);
  const lines: string[] = [
    `${a.code}  asof=${a.asof}  bars=${String(a.barsCount)}`,
    `趋势: ${DIR_EMOJI[a.trend.direction]} ${a.trend.direction}  置信度=${pct}%`,
    `  ${a.trend.rationale}`,
  ];
  if (a.supportLevels.length > 0) {
    lines.push(`支撑: ${a.supportLevels.map((l) => l.price).join(' / ')}`);
  }
  if (a.resistanceLevels.length > 0) {
    lines.push(`阻力: ${a.resistanceLevels.map((l) => l.price).join(' / ')}`);
  }
  return lines.join('\n');
}

export function renderTaSector(envelope: InstructionEnvelope<TaSectorResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { sectorId, sectorName, analysis } = envelope.data;
  return okResult(formatSectorAnalysis(sectorId, sectorName, analysis));
}

export function formatSectorAnalysis(
  sectorId: string,
  sectorName: string,
  a: TaSectorResult['analysis'],
): string {
  const conf = (a.overallConfidence * 100).toFixed(0);
  const head = [
    `${sectorId}  ${sectorName}  members=${String(a.members.length)}`,
    `整体: ${SECTOR_DIR_LABEL[a.overallDirection]}  置信度=${conf}%  (↑${String(a.trendBreakdown.up)} / ↓${String(a.trendBreakdown.down)} / →${String(a.trendBreakdown.sideways)})`,
  ].join('\n');
  const summary = a.summary.trim().length > 0 ? `\n\n${a.summary.trim()}` : '';
  const caveats = a.caveats.length > 0 ? `\n\n⚠ caveats: ${a.caveats.join('; ')}` : '';
  return `${head}${summary}${caveats}`;
}
