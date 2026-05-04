"""消息面分析模块的 prompt 集合（modules/06-sentiment-analysis.md）。

四段 prompt：

* ``build_stock_search_system_prompt`` / ``build_stock_search_user_prompt``
  —— 单股第 1 步：联网搜索分析师角色，返回**自由文本**研究纪要。
* ``build_stock_summarize_system_prompt`` / ``build_stock_summarize_user_prompt``
  —— 单股第 2 步：把上一步的纪要压成结构化 ``StockSentiment`` JSON
  （flash 模型，不需要 evidence）。
* ``build_cluster_system_prompt`` —— 多股题材归并
* ``build_market_synth_system_prompt`` —— 市场层 / 产业层综述

全部使用中文描述。所有 prompt 是纯字符串构造，不做 IO、不读 settings。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from datetime import date

    from quant_core.domain.types.stock import StockMeta


# -- 单股 第 1 步：联网搜索（输出自由文本） -------------------------------------


_STOCK_SEARCH_SYSTEM_PROMPT: Final[str] = (
    "你是资深股票分析师，擅长从产业趋势/消息面/预期差等方面分析股票的上涨动因。"
)


def build_stock_search_system_prompt() -> str:
    """单股第 1 步（联网搜索）的 system prompt。"""
    return _STOCK_SEARCH_SYSTEM_PROMPT


def build_stock_search_user_prompt(*, meta: StockMeta, asof: date, days: int) -> str:
    """单股第 1 步（联网搜索）的 user prompt。

    要求模型从 10 个角度对目标股票出具分析师式纪要；不要求 JSON、不要求
    URL evidence。返回的纯文本会被原样存入 ``StockSentiment.result``，
    并作为第 2 步 flash 模型的输入。
    """
    return (
        f"目标股票：{meta.name}（{meta.code}）。\n"
        f"所属行业：{meta.industries}\n"
        f"截止日期：{asof.isoformat()}（用户分析窗口：近 {days} 天）\n"
        "\n"
        "从并购/热点题材/核心产品/产品价格信号/竞争格局/竞争对手/市场份额/"
        "供需/研报目标/情绪评分等角度分析。"
    )


# -- 单股 第 2 步：结构化抽取（flash 模型，不需要 evidence） --------------------


_STOCK_SUMMARIZE_SCHEMA: Final[str] = """\
{
  "core_drivers":          [Insight, ...],
  "m_and_a":               [Insight, ...],
  "hot_themes":             [ThemeTag, ...],
  "core_products":         [ProductInfo, ...],
  "price_signals":         [PriceSignal, ...],
  "supply_demand":         [Insight, ...],
  "research_targets":      [ResearchTarget, ...],
  "competitive_landscape": CompetitiveLandscape | null,
  "sentiment_score":       number ∈ [-1, 1],
  "coverage_gaps":         [SourceType, ...],
  "caveats":               [string, ...]
}

Insight       = { "summary": str,
                  "direction": "positive"|"negative"|"neutral",
                  "confidence": number ∈ [0,1],
                  "is_rumor": bool }
ThemeTag      = { "label": str, "relevance": number ∈ [0,1], "rationale": str }
ProductInfo   = { "name": str, "revenue_share_pct": number|null, "note": str|null }
PriceSignal   = { "product": str,
                  "change": "price_up"|"price_down"|"shortage"|"destock"|"stable",
                  "horizon": "spot"|"short_term"|"mid_term",
                  "magnitude": str|null }
ResearchTarget= { "broker": str, "url": str, "rating": str|null,
                  "target_price": number|null, "target_upside_pct": number|null,
                  "horizon_months": int|null, "report_date": "YYYY-MM-DD"|null }
CompetitiveLandscape = {
  "market_position":  "leader"|"challenger"|"follower"|"niche"|"unclear",
  "market_share_pct": number|null,
  "summary":          str,
  "competitors":      [CompetitorInfo, ...],
  "moats":            [str, ...],
  "risks":            [str, ...]
}
CompetitorInfo = {
  "name":         str,
  "relation":     "domestic_peer"|"foreign_peer"
                | "substitute"|"upstream"|"downstream",
  "threat_level": "high"|"medium"|"low",
  "note":         str
}
SourceType    = "research" | "news" | "xueqiu" | "guba" | "industry"
"""


_STOCK_SUMMARIZE_SYSTEM_PROMPT: Final[str] = """\
你是消息面信息抽取助手。输入是另一名分析师对一只 A 股的研究纪要（自由
文本，可能含 markdown 表格 / 列表 / emoji）。请把内容压缩为下方 Schema
描述的**单个** JSON 对象，不要 markdown，不要任何 JSON 之外的文字。

抽取规则：

  1. 严格按 Schema 输出；不需要 ``evidence`` 字段，已在前置步骤完成核证。
  2. 原文未提及的字段一律给空数组 ``[]`` 或 ``null``，**不要捏造**。
  3. ``sentiment_score`` ∈ [-1, 1]，必须依据原文整体判断给出数字（强多
     头≈+0.6 以上；强空头≈-0.6 以下；摇摆 / 不确定接近 0）。
  4. ``hot_themes`` 按 ``relevance`` 倒序，最多 5 条。
  5. ``competitive_landscape`` 中 ``competitors`` 至少 2 条且最多 6 条；
     无可命名对手时整段置 ``null``。
  6. ``coverage_gaps`` 列出原文明显未覆盖的来源类型。
  7. 仅输出**一个** JSON 对象。

Schema：
{schema}
"""


def build_stock_summarize_system_prompt() -> str:
    """单股第 2 步（结构化抽取）的 system prompt。"""
    return _STOCK_SUMMARIZE_SYSTEM_PROMPT.format(schema=_STOCK_SUMMARIZE_SCHEMA)


def build_stock_summarize_user_prompt(
    *,
    meta: StockMeta,
    asof: date,
    days: int,
    research_text: str,
) -> str:
    """把第 1 步的研究纪要喂给 flash 模型抽取结构化字段。"""
    return (
        f"标的：{meta.name}（{meta.code}）\n"
        f"截止日期：{asof.isoformat()}（窗口：近 {days} 天）\n"
        "\n"
        "以下是分析师的研究纪要原文：\n"
        "<<<\n"
        f"{research_text}\n"
        ">>>\n"
        "\n"
        "请按 system prompt 中的 Schema 输出 JSON。"
    )


# -- 多股归并（不调用 web_search，仅做文本聚类） -----------------------------


_CLUSTER_SYSTEM_PROMPT: Final[str] = """\
你需要把语义相近的题材标签合并为稳定的题材簇。

输入：一个 ``stocks`` 数组，每个元素包含 (code, theme_label, rationale,
relevance)。
输出：**一个** JSON 对象 ``{"clusters": [Cluster, ...]}``，其中：

Cluster = {
  "theme_label":        str,
  "member_codes":       [str, ...],
  "related_industries": [str, ...],
  "heat_score":         number,
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
