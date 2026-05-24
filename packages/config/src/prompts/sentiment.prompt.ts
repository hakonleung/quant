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

export type SentimentMarket = 'a' | 'hk' | 'us';

export interface SentimentMeta {
  readonly market: SentimentMarket;
  readonly code: string;
  readonly name: string;
  readonly industries: string;
}

const MARKET_LABEL: Readonly<Record<SentimentMarket, string>> = {
  a: 'A 股',
  hk: '港股',
  us: '美股',
};

const STOCK_SCHEMA_DOC = `\
{
  "brief":   string,   // ≤120字 单段中文。必须优先点明"资本运作/重组预期"或"核心产品放量"等具体驱动事件名称，禁止八股套话/寒暄/免责
  "score":   number,   // ∈[-1,1]，最多两位小数。强多≈+0.6 强空≈-0.6
  "drivers": string[], // 每条 "summary|sign|conf|rumor" — summary≤30字且含具体数据/节点；sign=+|-|0；conf∈[0,1] 两位小数；rumor=0|1
  "themes":  string[], // 每条 "label|relevance|rationale" — label≤8字；relevance∈[0,1] 两位小数；rationale≤30字；按 relevance 倒序
  "products":string[], // 每条 "name|sharePct|note" — name≤12字；sharePct 数字%(如 30%)或留空；note≤20字
  "signals": string[], // 每条 "product|change|horizon|magnitude" — change=up|down|short|destock|stable；horizon=spot|short|mid；magnitude≤10字
  "mna":     string[], // 同 drivers 格式 (summary|sign|conf|rumor) — summary 中必须包含标的/阶段(rumor/planning/approved/completed)
  "supply":  string[], // 同 drivers 格式
  "research":string[], // 每条 "broker|rating|targetPrice|upsidePct|horizonMonths|reportDate" — 任一未知留空；date=YYYY-MM-DD 且必须 ≤ 评估锚点
  "competitive": {     // 或 null (无可命名对手时整个置 null)
    "pos":     "leader"|"challenger"|"follower"|"niche"|"unclear",
    "share":   number|null,                                  // 百分比数值，如 15.5 表 15.5%，未知 null
    "summary": string,                                       // ≤60字
    "competitors": string[],                                 // "name|relation|threat|note" — relation=domestic_peer|foreign_peer|substitute|upstream|downstream；threat=high|medium|low；note≤20字
    "moats":   string[],                                     // 每条≤15字
    "risks":   string[]                                      // 每条≤15字
  },
  "gaps":    string[], // 信息缺口来源标签 research|news|xueqiu|guba|industry
  "caveats": string[]  // 每条≤30字
}`;

function buildStockSystem(market: SentimentMarket): string {
  const label = MARKET_LABEL[market];
  return `\
你是顶级${label}量化基本面研究员。你必须主动调用 Web 搜索工具检索目标股票\
的真实最新资讯，再整合为高密度结构化 JSON 特征。

<objective>
输出一个合法的 minified JSON 对象。绝对禁止 markdown 标记、前后缀文字、换行缩进。
</objective>

<schema>
${STOCK_SCHEMA_DOC}
</schema>

<hard_rules>
1. 【搜索执行规范】必须且只能通过内置 Web 搜索工具检索；禁止仅凭离线知识库回答。\
若工具未返回结果，相应字段填空数组 / null，不得编造。
2. 【主营核验】首次搜索结果必须用于核验「公司名 ↔ 主营业务 ↔ 所属行业」三者一致；\
若发现张冠李戴 (同名/简称/曾用名混淆)，立即放弃当前线索重新检索。
3. 【重组预期优先】若检索到并购、资产注入、跨界收购、大股东 / 实控人变更，\
必须出现在 \`mna\` 中，且 \`brief\` 开头点明核心逻辑。
4. 【零幻觉红线】未在检索结果中得到证实的事实严禁出现；不确定时填 null / [] / rumor=1。
5. 【时效约束】\`research\` 的 reportDate 严禁早于评估锚点之前的过期数据；\
其他字段引用的事件优先选用窗口期内最新进展。
6. 【数组上限】drivers/mna/supply ≤5；themes ≤5 (relevance 倒序)；products ≤5；\
signals ≤5；research ≤5；competitors 2-6；moats/risks/gaps/caveats 各 ≤5。
7. 【管道符规范】所有以 \`|\` 分隔的字符串元素必须严格按 Schema 字段顺序与分隔符\
个数填写；缺失字段留空 (相邻 \`||\`)，不得跳过分隔符。
8. 【数值规范】JSON 顶层数值字段 (score, share) 必须是 number 或 null，\
禁止带单位字符串。管道内的数值表达可带 %, 万, 亿等单位。
9. 【JSON 安全】所有字符串中的 " 必须转义为 \\"；中文双引号不要在 JSON 字段中\
使用；不得出现裸换行 / 制表符。
10.【反照抄】Schema 注释 / 字段说明里的所有中文词组仅用于解释字段语义，禁止照搬。\
每条文本必须能映射回检索到的具体公司名 / 事件 / 日期 / 数值，否则视为捏造。
11.【行业回填】若 user prompt 中所属行业为空 (unknown)，必须先用 Web 搜索确定\
公司主营行业再继续分析；竞争对手 / 题材标签都依赖正确的行业归属。
</hard_rules>`;
}

export function buildSentimentSystem(market: SentimentMarket = 'a'): string {
  return buildStockSystem(market);
}

function shiftDate(asof: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(asof);
  if (m === null) return asof;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d) - days * 86400_000;
  const dt = new Date(t);
  const yy = String(dt.getUTCFullYear()).padStart(4, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function buildSentimentUser(args: {
  readonly meta: SentimentMeta;
  readonly asof: string;
  readonly days: number;
}): string {
  const start = shiftDate(args.asof, args.days);
  const label = MARKET_LABEL[args.meta.market];
  const industries = args.meta.industries.length > 0 ? args.meta.industries : 'unknown (请先检索补全)';
  const name = args.meta.name.length > 0 ? args.meta.name : `${args.meta.code} (中文/英文名请先检索补全)`;
  const year = String(args.asof).slice(0, 4);
  const queries = buildSearchQueries(args.meta.market, name, args.meta.code, year);
  return [
    '<context>',
    `市场: ${label}`,
    `目标股票: ${name} (${args.meta.code})`,
    `所属行业: ${industries}`,
    `评估锚点: ${args.asof}`,
    `检索时间窗口: ${start} 至 ${args.asof} (近 ${String(args.days)} 天)`,
    '</context>',
    '',
    '<search_instructions>',
    `请主动使用 Web 搜索工具, 围绕 "${name}" 或股票代码 "${args.meta.code}" 做多维度检索:`,
    ...queries.map((q, i) => `${String(i + 1)}. "${q}"`),
    '检索结果若早于时间窗口起点, 整段丢弃不采纳。',
    '中文资讯与英文资讯都可采纳; 港股 / 美股优先以披露易 / SEC / 公司官网 / 路透 / 彭博 / FT 为权威源。',
    '</search_instructions>',
    '',
    '<task>',
    `基于搜索取得的真实最新资讯, 识别${label}背景下的重组 / 资本运作预期、核心技术壁垒、\
短期价格催化剂与供需边际变化, 并按 system 中的 schema 输出**单行 minified JSON**。`,
    '严禁张冠李戴 (务必核验公司主营与代码对应), 严禁套用 schema 注释中的中文短语。',
    '</task>',
  ].join('\n');
}

function buildSearchQueries(
  market: SentimentMarket,
  name: string,
  code: string,
  year: string,
): readonly string[] {
  if (market === 'a') {
    return [
      `${name} ${code} 并购重组 资产注入 实控人变更`,
      `${name} 主营产品 市场占有率 产能 在手订单`,
      `${name} 研报 评级 目标价 ${year}`,
      `${name} 竞争对手 技术壁垒 国产替代`,
    ];
  }
  if (market === 'hk') {
    return [
      `${name} ${code} 港股 公告 配股 收购 私有化`,
      `${name} HKEX disclosure announcement filing ${year}`,
      `${name} 主营业务 市场份额 产能 订单`,
      `${name} broker rating target price upside ${year}`,
      `${name} competitors moat market position`,
    ];
  }
  return [
    `${name} ${code} M&A acquisition divestiture spinoff ${year}`,
    `${name} SEC 10-K 10-Q 8-K filing latest`,
    `${name} earnings guidance revenue segment ${year}`,
    `${name} analyst rating price target consensus upgrade downgrade`,
    `${name} competitors moat market share TAM`,
  ];
}

const CLUSTER_SCHEMA_DOC = `\
{
  "clusters": [
    {
      "label":      string,     // ≤8字
      "members":    string[],   // 股票代码原样, 不要改写大小写或补 0 (A 股 6 位数字 / 港股 4-5 位数字 / 美股字母 ticker)
      "industries": string[],   // 相关行业，每条≤8字，≤5条
      "heat":       number,     // ∈[-1,1]
      "trend":      "rising"|"stable"|"fading",
      "summary":    string      // ≤60字
    }
  ]
}`;

export function buildSentimentClusterSystem(market: SentimentMarket = 'a'): string {
  const label = MARKET_LABEL[market];
  return `\
你需要把${label}多只股票的题材标签合并为稳定的题材簇。输出**单行 minified JSON**，
schema：
${CLUSTER_SCHEMA_DOC}

硬性规则：
  1. 输入中的每一个 code 必须出现在**恰好一个** cluster 的 \`members\` 中。
  2. **绝不**凭空发明输入中没有的 code；输出的 code 必须与输入字面相同 (区分大小写)。
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

export function buildSentimentMarketSynthSystem(market: SentimentMarket = 'a'): string {
  const label = MARKET_LABEL[market];
  return `\
你需要根据已分析的多只${label}消息面 + 题材簇，综合判断市场层与产业层观点。
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
