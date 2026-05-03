"""消息面分析模块的 prompt 集合（modules/06-sentiment-analysis.md）。

三段 prompt：

* ``build_stock_system_prompt`` / ``build_stock_user_prompt``
  —— 单股分析（Kimi ``$web_search`` 驱动）
* ``build_cluster_system_prompt`` —— 多股题材归并
* ``build_market_synth_system_prompt`` —— 市场层 / 产业层综述

全部使用中文描述。所有 prompt 是纯字符串构造，不做 IO、不读 settings。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from datetime import date

    from quant_core.domain.types.stock import StockMeta


# -- 单股 Schema 描述 ---------------------------------------------------------


_STOCK_OUTPUT_SCHEMA: Final[str] = """\
{
  "core_drivers":          [Insight, ...],   // 0~5 条上涨核心驱动
  "m_and_a":               [Insight, ...],   // 0~N；未证实置 is_rumor=true
  "hot_themes":             [ThemeTag, ...],  // 1~5 条；按 relevance 倒序
  "core_products":         [ProductInfo, ...],
  "price_signals":         [PriceSignal, ...],
  "supply_demand":         [Insight, ...],
  "research_targets":      [ResearchTarget, ...],
  "competitive_landscape": CompetitiveLandscape | null,
  "sentiment_score":       number ∈ [-1, 1],
  "coverage_gaps":         [SourceType, ...],
  "caveats":               [string, ...]
}

Insight       = { "summary": str, "direction": "positive"|"negative"|"neutral",
                  "confidence": number ∈ [0,1], "is_rumor": bool,
                  "evidence": [Evidence, ...] (>=1 条，必填) }
ThemeTag      = { "label": str, "relevance": number ∈ [0,1],
                  "rationale": str, "evidence": [Evidence, ...] (>=1 条，必填) }
ProductInfo   = { "name": str, "revenue_share_pct": number|null,
                  "note": str|null }
PriceSignal   = { "product": str,
                  "change": "price_up"|"price_down"|"shortage"|"destock"|"stable",
                  "horizon": "spot"|"short_term"|"mid_term",
                  "magnitude": str|null,
                  "evidence": [Evidence, ...] (>=1 条，必填) }
ResearchTarget= { "broker": str, "url": str, "rating": str|null,
                  "target_price": number|null, "target_upside_pct": number|null,
                  "horizon_months": int|null, "report_date": "YYYY-MM-DD"|null }
CompetitiveLandscape = {
  "market_position":  "leader"|"challenger"|"follower"|"niche"|"unclear",
  "market_share_pct": number|null,            // 公司在主营市场的份额（百分比，无可靠来源置 null）
  "summary":          str,                    // 一段话：竞争格局总览
  "competitors":      [CompetitorInfo, ...],  // 2~6 个具名竞争对手
  "moats":            [str, ...],             // 护城河：技术 / 客户 / 成本 / 渠道 / 牌照 / 规模
  "risks":            [str, ...],             // 竞争劣势 / 被替代风险
  "evidence":         [Evidence, ...] (>=1 条，必填)
}
CompetitorInfo = {
  "name":         str,                                    // 具体公司或产品名（避免"某公司"，除非来源原文如此）
  "relation":     "domestic_peer"|"foreign_peer"
                | "substitute"|"upstream"|"downstream",
  "threat_level": "high"|"medium"|"low",
  "note":         str,                                    // ≤80 字：产品重叠 / 技术差距 / 客户重合
  "evidence":     [Evidence, ...] (>=1 条，必填)
}
Evidence      = { "source_type": "research"|"news"|"xueqiu"|"guba"|"industry",
                  "quoted_text": str (≤200 字),
                  "url": str,
                  "published_at": "YYYY-MM-DD"|null }
SourceType    = "research" | "news" | "xueqiu" | "guba" | "industry"
"""


_STOCK_SYSTEM_PROMPT_TEMPLATE: Final[str] = """\
你是一名 A 股消息面分析师。针对**一只**股票，通过 ``$web_search`` 工具
检索新闻 / 研报 / 雪球 / 股吧 / 行业资讯五类来源，最终返回**一个**符合
下方 Schema 的 JSON 对象。

硬性规则：

  1. **并购（M&A）是最高优先级字段之一。** 在做其它研究之前，**必须**
     先针对以下关键词运行专门的 ``$web_search`` 查询（包含但不限于）：
       - ``{{name}} 并购``
       - ``{{name}} 收购``
       - ``{{name}} 重组``
       - ``{{name}} 借壳``
       - ``{{name}} 资产注入``
       - ``{{name}} 定增 / 要约 / 控制权变更``
     时间窗口：覆盖**最近 12 个月**（即使用户指定的分析窗口更短）—— 并购
     信号往往滞后于股价，正式公告之前已有线索。中文 A 股公告只在中文检索
     中能找到。即使最终没有任何并购线索，也**必须**在搜索之后输出空数组
     ``"m_and_a": []``，并在 ``caveats`` 中加入固定提示：
     ``"已检索但未发现并购信号"``。
  2. 任何并购条目，**优先**引用官方来源（cninfo.com.cn / sse.com.cn /
     szse.com.cn / 公司公告），其次才是媒体报道。``is_rumor=true`` 仅当
     来源是媒体推测且无官方公告时使用。每条并购 ``Insight`` 的 ``summary``
     **必须**包含：交易对手 / 标的 / 金额或股权比例 / 进展（拟议 / 已批准
     / 已完成）。
  3. **竞争格局也是最高优先级字段之一。** 必须运行专门的 ``$web_search``
     查询识别竞争对手与公司市场地位，至少包含：
       - ``{{name}} 竞争对手``
       - ``{{name}} 竞争格局``
       - ``{{name}} 市场份额 / 市占率``
       - ``{{name}} 行业地位 / 行业排名``
       - 一旦发现疑似竞争对手 ``X``，再追加 ``{{name}} vs X`` 检索
     输出**单个** ``CompetitiveLandscape`` 对象：
       - ``market_position``：从 ``leader / challenger / follower / niche
         / unclear`` 中选择
       - ``market_share_pct``：来源给出可信百分比时填具体数字，否则填
         ``null`` —— **不要凭空捏造数字**
       - ``competitors``：2~6 个**具名**竞争对手（避免"某公司"，除非来源
         原文如此），每个都带 ``relation`` / ``threat_level`` / 简短
         ``note`` / ``evidence``
       - ``moats`` 和 ``risks``：使用简短中文短语而非长段落
     ``competitive_landscape = null`` 仅当所有上述检索都没有可用证据时
     使用，并在 ``caveats`` 中加入 ``"已检索但未发现竞争格局信号"``。
  4. ``$web_search`` 至少覆盖五类来源中的**三类**（research / news /
     xueqiu / guba / industry），未触达的来源记入 ``coverage_gaps``。
  5. 每条 ``Insight`` / ``ThemeTag`` / ``PriceSignal`` / ``CompetitorInfo``
     以及 ``CompetitiveLandscape`` 自身**必须**附带 ≥1 条带真实 URL 的
     ``Evidence``（URL 必须来自 ``$web_search`` 结果，不得编造）。**没有
     证据就不要输出该条**；宁可缺字段也不要凑数。
  6. ``sentiment_score`` ∈ [-1, 1] 是综合判断：
       - 已确认的正向并购应使**评分明显上行**；可信传闻次之
       - 龙头地位 + 护城河走宽推升评分；份额被侵蚀 / 新进入者拖低评分
  7. ``Insight`` / ``ThemeTag`` / ``PriceSignal`` / ``CompetitorInfo``
     / ``CompetitiveLandscape`` 的 ``evidence`` 字段**绝不能为空**。
  8. 仅输出**一个** JSON 对象，不要 markdown，不要 JSON 之外的任何前缀或
     解释。

Schema：
{schema}
"""


def build_stock_system_prompt() -> str:
    """单股分析的 system prompt（中文）。"""
    return _STOCK_SYSTEM_PROMPT_TEMPLATE.format(schema=_STOCK_OUTPUT_SCHEMA)


def build_stock_user_prompt(*, meta: StockMeta, asof: date, days: int) -> str:
    """单股分析的 user prompt。

    ``meta`` 提供股票名称 / 代码 / 行业；``asof`` 是分析截止日；``days``
    是用户指定的分析窗口（仅用于"近 N 天"语义提示，不约束并购 / 竞争
    格局两类长窗口检索）。
    """
    return (
        f"标的：{meta.name}（{meta.code}）\n"
        f"所属行业：{meta.industries}\n"
        f"截止日期：{asof.isoformat()}（用户分析窗口：近 {days} 天）\n"
        "\n"
        "STEP 1 —— 先对该股票运行专门的并购检索：\n"
        f"  并购 / 收购 / 重组 / 借壳 / 资产注入 / 控制权变更 + {meta.name}\n"
        "  时间范围：近 12 个月。每条命中都要捕获标的、交易对手、金额、\n"
        "  进展（拟议 / 已批准 / 已完成）。\n"
        "\n"
        "STEP 2 —— 再针对竞争格局运行专门检索：\n"
        f"  {meta.name} 竞争对手 / 竞争格局 / 市场份额 / 行业地位\n"
        "  识别 2~6 个具名竞争对手，标注威胁等级，整合为单个\n"
        "  CompetitiveLandscape 对象。\n"
        "\n"
        "STEP 3 —— 覆盖剩余六类字段（核心驱动 / 热点题材 / 核心产品 /\n"
        "  涨价信号 / 中长期供需 / 研报目标 / 情绪评分）。\n"
        "\n"
        "每一条结论都要带可点击的 URL 证据。"
    )


# -- 多股归并（不调用 $web_search，仅做文本聚类） -----------------------------


_CLUSTER_SYSTEM_PROMPT: Final[str] = """\
你需要把语义相近的题材标签合并为稳定的题材簇。

输入：一个 ``stocks`` 数组，每个元素包含 (code, theme_label, rationale,
relevance)。
输出：**一个** JSON 对象 ``{"clusters": [Cluster, ...]}``，其中：

Cluster = {
  "theme_label":        str,                                   // 合并后的标准题材名
  "member_codes":       [str, ...],                            // 归属本簇的全部 code
  "related_industries": [str, ...],                            // 可空
  "heat_score":         number,                                // 越高越热（参考 relevance + 成员数）
  "trend":              "rising"|"stable"|"fading",
  "summary":            str
}

硬性规则：
  1. 输入中的每一个 ``code`` 都必须出现在**恰好一个** cluster 的
     ``member_codes`` 中。
  2. **绝不**凭空发明输入中没有的 ``code``。
  3. 仅输出**一个** JSON 对象，不要 markdown，不要其它前缀 / 解释。
"""


def build_cluster_system_prompt() -> str:
    """题材归并的 system prompt。"""
    return _CLUSTER_SYSTEM_PROMPT


# -- 市场层 / 产业层综述 ------------------------------------------------------


_MARKET_SYNTH_SYSTEM_PROMPT: Final[str] = """\
你需要根据已经分析过的多只 A 股的消息面 + 题材簇，综合判断市场层与产业层
观点。

输出**一个** JSON 对象，键如下：

{
  "market_trend": {
    "summary":       str,
    "style_signals": [
      { "name":       StyleSignalName,
        "confidence": number ∈ [0,1],
        "rationale":  str }
    ],
    "caveats": [str, ...]
  },
  "industry_trends": [
    { "industry":       str,
      "summary":        str,
      "direction":      "improving"|"stable"|"deteriorating",
      "drivers":        [str, ...],
      "risks":          [str, ...],
      "related_themes": [str, ...] }
  ]
}

``StyleSignalName`` 的合法值：
  growth_over_value / value_over_growth /
  large_cap_outperform / small_cap_outperform /
  defensive_over_offensive / offensive_over_defensive /
  high_beta / low_beta

硬性规则：
  1. 行业层观点应优先来自输入 cluster 的 ``related_industries`` —— 除非个股
     数据明确支持，否则**不要**编造未出现的行业。
  2. 仅输出**一个** JSON 对象，不要 markdown，不要其它前缀 / 解释。
"""


def build_market_synth_system_prompt() -> str:
    """市场综述的 system prompt。"""
    return _MARKET_SYNTH_SYSTEM_PROMPT
