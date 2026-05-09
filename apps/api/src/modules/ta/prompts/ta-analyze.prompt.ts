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

输入是一只股票最近不超过 90 个交易日的日线数据（前复权价 + 预计算的 \
MA5/10/20/60 + 成交量）。请只基于这些价量数据进行分析；**不要**\
编造基本面、新闻、公司事件、宏观政策等信息。

输出必须是单个合法 JSON 对象，结构如下，不要额外文字、不要 markdown 包裹：

{
  "support_levels": [          // 支撑位，从最近到最远排序，最多 5 个
    {
      "price": "12.34",        // 字符串形式的小数（前复权价坐标系，与输入一致）
      "strength": "weak" | "medium" | "strong",
      "reason": "简明中文，例：MA60 支撑+前期密集成交区"
    }
  ],
  "resistance_levels": [...],  // 阻力位，从最近到最远排序，最多 5 个
  "trend": {
    "direction": "up" | "down" | "sideways",
    "horizon_days": 5,         // 预测时间范围（交易日数），通常 5-20
    "confidence": 0.65,        // [0,1]
    "rationale": "简明中文走势依据"
  },
  "patterns": ["三角整理", "MA60 上穿 MA20"],   // 0-5 个图形/技术形态
  "caveats": []                                // 可选：数据不足、停牌缺口等警告
}

强约束：
1. price 字段必须是 **字符串形式的小数**（避免精度丢失），与输入价同精度。
2. confidence 必须是 0~1 的小数。
3. strength 取值仅限 weak/medium/strong；direction 仅限 up/down/sideways。
4. 支撑位价格应低于最新收盘价；阻力位应高于最新收盘价。允许极少数例外（突破后回踩），\
但需在 reason 中说明。
5. 不要在 patterns / caveats 中重复 trend.rationale 的内容。`;

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
    args.bars.length === 0
      ? '(no bars available)'
      : [HEADER, ...args.bars.map(fmtBar)].join('\n');
  return [
    `股票: ${args.code} ${args.name}`,
    `所属行业: ${args.industries}`,
    `分析基准日: ${args.asof}`,
    `最近 ${String(args.bars.length)} 个交易日数据 (CSV，价格为前复权):`,
    body,
    '',
  ].join('\n');
}
