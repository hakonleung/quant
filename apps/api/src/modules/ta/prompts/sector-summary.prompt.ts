/**
 * Prompt for the sector-level TA narrative. Per-stock TA cards are
 * produced by `analyze_ta_one` (Python); this LLM call only sees the
 * compact `members[]` summary + the aggregate trend distribution and
 * produces a 2-3 paragraph Chinese write-up suitable for a brief.
 *
 * Response is plain markdown text, not JSON — the caller wraps it.
 */

import type { TaSectorMember } from '@quant/shared';

const SYSTEM = `你是A股技术面分析师。基于一组成分股的技术分析摘要,产出对应板块的技术面综述。

要求:
1. 全文使用简体中文,2-3 段, 200-400 字。
2. 概括趋势分布 (上涨/下跌/震荡占比)与置信度,指出主导方向。
3. 提炼共性形态 / 关键支撑阻力共识(若多只股票指向同一价位区间)。
4. 标注至少一条风险点 (例: 高位放量、跌破重要均线、形态背离)。
5. 不要给出价格预测、不要使用"建议买入/卖出"等表述、不要使用数字标签序号。`;

interface PromptInput {
  readonly sectorLabel: string;
  readonly members: readonly TaSectorMember[];
  readonly trendBreakdown: {
    readonly up: number;
    readonly down: number;
    readonly sideways: number;
  };
  readonly overallDirection: 'up' | 'down' | 'sideways';
  readonly overallConfidence: number;
}

export function buildSectorSummaryPrompt(input: PromptInput): {
  readonly system: string;
  readonly user: string;
} {
  const lines: string[] = [];
  lines.push(`板块/篮子: ${input.sectorLabel}`);
  lines.push(
    `趋势分布: 上涨 ${String(input.trendBreakdown.up)} 只 / 下跌 ${String(
      input.trendBreakdown.down,
    )} 只 / 震荡 ${String(input.trendBreakdown.sideways)} 只`,
  );
  lines.push(
    `主导方向: ${input.overallDirection} (平均置信度 ${input.overallConfidence.toFixed(2)})`,
  );
  lines.push('');
  lines.push('成分股技术摘要 (CSV):');
  lines.push('code,name,asof,trend,confidence,key_resistance,key_support,headline');
  for (const m of input.members) {
    const cells = [
      m.code,
      m.name.replace(/,/gu, ' '),
      m.asof,
      m.trend.direction,
      m.trend.confidence.toFixed(2),
      m.keyResistance ?? '',
      m.keySupport ?? '',
      m.headline.replace(/[\n,]/gu, ' '),
    ];
    lines.push(cells.join(','));
  }
  return { system: SYSTEM, user: lines.join('\n') };
}
