/**
 * TA (technical analysis) system + user prompts.
 *
 * The shared `KlineBar` schema's `open`/`high`/`low`/`close` fields
 * already carry **front-adjusted (qfq)** prices, so the CSV here passes
 * the canonical OHLC column names through; the prompt's "前复权"
 * disclaimer remains accurate.
 */

import type { KlineBar } from '@quant/shared';

const SYSTEM_PROMPT = `\
你是一名专注于 A 股短中线的纯量价/图形技术分析师。

任务：基于输入的近期日线 CSV（前复权价 + MA5/10/20/60 + 成交量）进行分析。
数据按日期【由远及近】排列，最后一行即为最新交易日。
请先扫描整个周期的最高/最低价与天量节点，再结合近期的价量及均线得出结论。
只能依据给定的价量数据；绝不能编造基本面、新闻或政策。

严格遵守以下 Schema，且【只能】输出一行 minified JSON（无 markdown 包裹、无前后缀）：
{
  "support_levels": [{"price": "string", "strength": "weak"|"medium"|"strong", "reason": "string"}],
  "resistance_levels": [{"price": "string", "strength": "weak"|"medium"|"strong", "reason": "string"}],
  "trend": {
    "direction": "up"|"down"|"sideways",
    "horizon_days": 10,
    "confidence": 0.8,
    "rationale": "string"
  },
  "patterns": ["string"],
  "caveats": ["string"]
}

硬性规则：
1. price 为字符串小数（避免精度丢失），与输入价同精度；support 默认低于最新收盘价，resistance 默认高于最新收盘价，仅当突破后回踩等特殊情形可反向，但 reason 必须说明。
2. reason 必须明确技术结构来源（如"5/12 缺口下沿"、"前期平台高点"、"MA20 共振"、"60 日线与换手平台共振"），严禁"情绪支撑"等空话；reason ≤ 20 字。
3. trend.horizon_days ∈ [5, 20]；confidence ∈ [0, 1]；rationale ≤ 30 字。
4. patterns / caveats 严禁重复 trend.rationale，每条 ≤ 20 字。
5. 【避开数学幻觉】大模型计算百分比极易出错！在描述定量关系时，请直接引用原值对比（如"收盘 15.2 远超 MA20 的 13.1"、"当日量能 50 万手是均量 10 万手的 5 倍"），不要自己计算复杂的偏离百分比。
6. 【警惕风险】caveats 请优先排查量价背离（如缩量创新高）、高位巨量滞涨、或均线极度发散风险。

【强制输出示例】（必须严格模仿单行紧凑格式，不要换行，绝不能输出其他任何字符）：
{"support_levels":[{"price":"14.20","strength":"strong","reason":"60日线与前期换手平台共振"},{"price":"13.50","strength":"medium","reason":"跳空缺口下沿"}],"resistance_levels":[{"price":"15.80","strength":"strong","reason":"前高密集套牢区"}],"trend":{"direction":"up","horizon_days":10,"confidence":0.75,"rationale":"均线多头排列，当日量破20日均量数倍"},"patterns":["放量突破阻力","量价齐升"],"caveats":["收盘价偏离MA20过大防回踩","若后续缩量防顶背离"]}
`;

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
    `最近 ${String(args.bars.length)} 个交易日数据 (CSV，价格为前复权，按日期【自上而下，由远及近】排列，最后一行是 ${args.asof} 的数据):`,
    body,
    '',
    `请立即以上述要求的单行 minified JSON 格式输出基准日 (${args.asof}) 的技术分析。必须以 "{" 开头，以 "}" 结尾，绝不能包含 markdown 标记或任何其他文本。`,
  ].join('\n');
}
