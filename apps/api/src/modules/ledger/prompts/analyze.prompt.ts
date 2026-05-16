/**
 * Prompt templates for the personal-ledger AI analysis.
 *
 * Mirrors `services/py/quant_core/prompts/ledger_prompts.py` line-for-line —
 * the prompt is the LLM behaviour contract; both sides must stay in sync
 * if anyone tweaks it. The system prompt fixes the JSON output shape; the
 * user prompt embeds a CSV of the last ≤ 30 enriched entries.
 */

import type { EnrichedLedgerEntry } from '@quant/shared';

const SYSTEM_PROMPT = `\
你是一名 A 股个人交易者的复盘助手。

输入是一段不超过 30 个交易日的个人盈亏账本：
- pnl_amount: 当日盈亏金额（元，可为负）
- closing_position: 当日收盘后账户净值
- closing_provided: 该 closing 是否为用户实录（true）或链式推导（false）
- cash_flow: 隐含资金流，= Δclosing − pnl_amount，非零表示当日有出入金 / 分红
- daily_pct: 当日盈亏占前一日 closing 的百分比

**只**根据上述盈亏与仓位变化，从用户操作风格与市场环境两个角度给出复盘\
分析。**严禁**：
- 推荐具体股票或板块
- 编造与盈亏数据无关的新闻、政策、宏观背景
- 把 cash_flow 当成盈亏（这是出入金，不是交易结果）

输出**单行 minified JSON**（无 markdown 包裹、无前后缀），schema：

{
  "summary":         string,   // ≤80字, 盈亏与仓位画像
  "operation_style": string,   // ≤50字, 例「波段为主, 仓位浮动 40%~80%」
  "market_view":     string,   // ≤60字, 例「上涨段, 胜率约 X%」
  "recommendations": string[]  // ≤3 条, 每条 ≤30字, 不涉及具体标的
}

严格遵守字数上限（超出会被裁掉, 请自行精简）。`;

export function buildLedgerSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

const HEADER = 'date,pnl_amount,closing_position,closing_provided,cash_flow,daily_pct';

function formatEntry(entry: EnrichedLedgerEntry): string {
  return [
    entry.date,
    entry.pnlAmount,
    entry.derivedClosingPosition,
    entry.closingProvided ? 'true' : 'false',
    entry.cashFlow,
    entry.derivedDailyPct,
  ].join(',');
}

export function buildLedgerUserPrompt(entries: readonly EnrichedLedgerEntry[]): string {
  if (entries.length === 0) return '（账本为空）';
  const body = entries.map(formatEntry).join('\n');
  return (
    `以下是最近 ${String(entries.length)} 个交易日的账本（CSV 表头先于数据，仅一行表头）：\n\n` +
    `${HEADER}\n${body}\n`
  );
}
