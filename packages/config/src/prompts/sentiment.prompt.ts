/**
 * Sentiment-pipeline prompts (modules/05-sentiment.md).
 *
 * Single-stock: one combined web-search + JSON-mode call. The model
 * researches via the provider's native web search and emits the
 * minimal-payload JSON directly (no intermediate research-notes pass).
 * Each array entry is a `"|"`-separated compact string; the NestJS
 * parser splits and types it before reaching FE/IM. Per-field char
 * caps are enforced via prompt — model adherence is enough since we
 * never retry on parse failure.
 *
 * Multi-stock: cluster + market-synth passes are still standalone
 * JSON-mode calls (no web search needed), same minimal-string wire.
 */

export interface SentimentMeta {
  readonly code: string;
  readonly name: string;
  readonly industries: string;
}

const STOCK_SCHEMA_DOC = `\
{
  "brief":   string,   // ≤120字「上涨核心动因分析」一段话，紧凑不寒暄
  "score":   number,   // ∈[-1,1]，强多头≈+0.6 强空头≈-0.6
  "drivers": string[], // 每条 "summary|+/-/0|conf|rumor" — summary≤30字 conf∈[0,1] rumor=0|1
  "themes":  string[], // 每条 "label|relevance|rationale" — label≤8字 relevance∈[0,1] rationale≤30字
  "products":string[], // 每条 "name|sharePct|note" — name≤12字 sharePct数字或空 note≤20字或空
  "signals": string[], // 每条 "product|change|horizon|magnitude" — change=up|down|short|destock|stable horizon=spot|short|mid magnitude≤10字或空
  "mna":     string[], // 同 drivers
  "supply":  string[], // 同 drivers
  "research":string[], // 每条 "broker|rating|targetPrice|upsidePct|horizonMonths|reportDate" — 任一未知留空，date=YYYY-MM-DD
  "competitive": {     // 或 null
    "pos":     "leader"|"challenger"|"follower"|"niche"|"unclear",
    "share":   number|null,
    "summary": string,                                       // ≤60字
    "competitors": string[],                                 // "name|relation|threat|note" — relation=domestic_peer|foreign_peer|substitute|upstream|downstream threat=high|medium|low note≤20字
    "moats":   string[],                                     // 每条≤15字
    "risks":   string[]                                      // 每条≤15字
  },
  "gaps":    string[], // 来自 research|news|xueqiu|guba|industry
  "caveats": string[]  // 每条≤30字
}`;

const STOCK_SYSTEM = `\
你是资深 A 股分析师，借助 web 搜索整合并购/热点题材/核心产品/价格信号/竞争\
格局/供需/研报目标/情绪等维度，输出**单个**合法 minified JSON 对象。

**只输出 JSON，无 markdown 包裹、无前后缀文字、无换行缩进。**

Schema（每条字符串用 \`|\` 分隔，按下列字段顺序）：
${STOCK_SCHEMA_DOC}

硬性规则：
  1. 严格按 Schema 输出；原文未提及的字段给空数组 \`[]\` 或 \`null\`，**不要捏造**。
  2. 数组上限：drivers/mna/supply ≤5 条；themes ≤5 条且按 relevance 倒序；
     products ≤5 条；signals ≤5 条；research ≤5 条；competitors 2-6 条
     （无可命名对手时整个 competitive 置 null）；moats/risks/gaps/caveats 各 ≤5 条。
  3. \`brief\` 是单段中文要点（≤120字），紧扣"上涨核心动因"，不要寒暄/免责。
  4. \`score\` ∈ [-1, 1]，必须根据搜索结果整体判断。
  5. 数值字段无信息时写 \`null\`（不要 0 / "" / "未知"）。
  6. 所有字符串字段严格遵守上文字数上限（超出会被裁掉，请自行精简）。`;

export function buildSentimentSystem(): string {
  return STOCK_SYSTEM;
}

export function buildSentimentUser(args: {
  readonly meta: SentimentMeta;
  readonly asof: string;
  readonly days: number;
}): string {
  return [
    `目标股票：${args.meta.name}（${args.meta.code}）`,
    `所属行业：${args.meta.industries}`,
    `截止日期：${args.asof}（窗口：近 ${String(args.days)} 天）`,
    '',
    '请通过 web 搜索收集近期资讯后，按 system prompt 中的 Schema 输出**单行 minified JSON**。',
  ].join('\n');
}

const CLUSTER_SCHEMA_DOC = `\
{
  "clusters": [
    {
      "label":      string,     // ≤8字
      "members":    string[],   // 6位股票代码
      "industries": string[],   // 相关行业，每条≤8字，≤5条
      "heat":       number,     // ∈[-1,1]
      "trend":      "rising"|"stable"|"fading",
      "summary":    string      // ≤60字
    }
  ]
}`;

export function buildSentimentClusterSystem(): string {
  return `\
你需要把语义相近的题材标签合并为稳定的题材簇。输出**单行 minified JSON**，
schema：
${CLUSTER_SCHEMA_DOC}

硬性规则：
  1. 输入中的每一个 code 必须出现在**恰好一个** cluster 的 \`members\` 中。
  2. **绝不**凭空发明输入中没有的 code。
  3. clusters ≤ 6 条；每个 cluster summary ≤ 60字。
  4. 只输出 JSON，无 markdown、无前后缀。`;
}

export function buildSentimentClusterUser(payload: unknown): string {
  return `输入（code/theme/rationale/relevance）：\n${JSON.stringify(payload)}`;
}

const SYNTH_SCHEMA_DOC = `\
{
  "brief": string,            // ≤120字 市场综述
  "styleSignals": string[],   // 每条 "name|confidence|rationale" — name=growth_over_value|value_over_growth|large_cap_outperform|small_cap_outperform|defensive_over_offensive|offensive_over_defensive|high_beta|low_beta，confidence∈[0,1]，rationale≤30字
  "industryTrends": string[], // 每条 "industry|summary|direction|drivers|risks|relatedThemes" — direction=improving|stable|deteriorating；drivers/risks/relatedThemes 用 \`;\` 分隔（每个 ≤8字）；summary ≤40字
  "caveats": string[]         // 每条≤30字
}`;

export function buildSentimentMarketSynthSystem(): string {
  return `\
你需要根据已分析的多只 A 股消息面 + 题材簇，综合判断市场层与产业层观点。
输出**单行 minified JSON**，schema：
${SYNTH_SCHEMA_DOC}

硬性规则：
  1. 行业层观点应优先来自输入 cluster 的 industries —— 除非个股数据明确支持，
     否则**不要**编造未出现的行业。
  2. styleSignals ≤ 4 条；industryTrends ≤ 5 条。
  3. 只输出 JSON，无 markdown、无前后缀。`;
}

export function buildSentimentMarketSynthUser(payload: unknown): string {
  return `输入（stocks + clusters）：\n${JSON.stringify(payload)}`;
}
