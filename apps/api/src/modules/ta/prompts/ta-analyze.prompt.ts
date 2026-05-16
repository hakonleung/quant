/**
 * TA (technical analysis) system + user prompts.
 *
 * Port of `services/py/quant_core/prompts/ta_prompts.py`. The system
 * prompt pins the JSON output shape; the user prompt embeds a compact
 * CSV of up to 90 daily bars (qfq OHLCV + pre-computed MAs).
 *
 * The shared `KlineBar` schema's `open`/`high`/`low`/`close` fields
 * already carry **front-adjusted (qfq)** prices (see
 * `apps/api/src/modules/kline/domain/arrow-mapper.ts:1` — the mapper
 * surfaces qfq columns under the canonical OHLC names because the chart
 * needs a continuous series across splits). So the CSV here passes the
 * same column names through; the prompt's "前复权" disclaimer remains
 * accurate.
 */

import type { KlineBar } from '@quant/shared';

const SYSTEM_PROMPT = `\
你是一名专注于 A 股短中线的纯量价/图形技术分析师。

输入：一只股票最近不超过 90 个交易日的日线数据（前复权价 + MA5/10/20/60
+ 成交量）。请只基于这些价量数据；**不要**编造基本面/新闻/政策。

输出**单行 minified JSON**（无 markdown 包裹、无前后缀），schema：

{
  "support_levels":    Level[],   // ≤2 条，从近到远；price 低于最新收盘价
  "resistance_levels": Level[],   // ≤2 条，从近到远；price 高于最新收盘价
  "trend": {
    "direction":   "up"|"down"|"sideways",
    "horizon_days": int,          // 5~20
    "confidence":   number ∈ [0,1],
    "rationale":    string        // ≤30字
  },
  "patterns": string[],           // ≤2 条，每条 ≤12字
  "caveats":  string[]            // ≤2 条，每条 ≤20字
}
Level = { "price": string, "strength": "weak"|"medium"|"strong", "reason": string }
  - price 为字符串小数（避免精度丢失），与输入价同精度
  - reason ≤20字

硬性规则：
1. confidence ∈ [0,1]；strength 仅限 weak/medium/strong；direction 仅限 up/down/sideways。
2. 极少数情况（突破后回踩）允许支撑高于现价 / 阻力低于现价，但需在 reason 中说明。
3. patterns / caveats 不要重复 trend.rationale。
4. 所有字段严格遵守字数上限（超出会被裁掉）。`;

export function buildTaSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

const HEADER = 'date,open,high,low,close,volume,ma5,ma10,ma20,ma60';

function fmtNum(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '';
  return String(n);
}

function fmtBar(b: KlineBar): string {
  return [
    b.date,
    fmtNum(b.open),
    fmtNum(b.high),
    fmtNum(b.low),
    fmtNum(b.close),
    fmtNum(b.volume),
    fmtNum(b.ma5),
    fmtNum(b.ma10),
    fmtNum(b.ma20),
    fmtNum(b.ma60),
  ].join(',');
}

export function buildTaUserPrompt(args: {
  readonly code: string;
  readonly name: string;
  readonly industries: string;
  readonly asof: string;
  readonly bars: readonly KlineBar[];
}): string {
  const body =
    args.bars.length === 0 ? '(no bars available)' : [HEADER, ...args.bars.map(fmtBar)].join('\n');
  return [
    `股票: ${args.code} ${args.name}`,
    `所属行业: ${args.industries}`,
    `分析基准日: ${args.asof}`,
    `最近 ${String(args.bars.length)} 个交易日数据 (CSV，价格为前复权):`,
    body,
    '',
  ].join('\n');
}
