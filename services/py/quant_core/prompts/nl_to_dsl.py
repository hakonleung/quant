"""自然语言 → 筛选 DSL 翻译的 prompt（modules/03-screening.md §6）。

输出 JSON 顶层字段：``screen_plan`` / ``universe_plan`` / ``rank`` /
``warnings``。Few-shot 涵盖 K 线条件、Universe 预过滤、top-N 排序。

prompt 已从原 ``nl_to_dsl_service`` 迁出，集中维护，方便与消息面分析等
其它中文 prompt 一起 diff / 演进。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from datetime import date


_SCREEN_FIELDS: Final[str] = (
    "open, high, low, close, open_qfq, high_qfq, low_qfq, close_qfq, "
    "volume, amount, turnover_rate, ma5, ma10, ma20, ma60, pct_chg_qfq"
)
_UNIVERSE_FIELDS: Final[str] = (
    "code, name, industries, list_date, float_pct, is_st, exchange, listed_days"
)


# few-shot 示例覆盖 modules/03 §3 的四类典型查询，外加一个 universe 预过滤
# （ST + 北交所）和一个 top-N 排序，让模型至少见过每一个输出通道。
_NL_TO_DSL_SYSTEM_PROMPT_TEMPLATE: Final[str] = """\
你将中文 A 股筛选自然语言指令翻译为严格的 JSON DSL。

始终返回**一个** JSON 对象，顶层键如下：

  - ``screen_plan``     （必填）—— K 线 predicate AST
  - ``universe_plan``   （可选）—— 个股元数据预过滤
  - ``rank``            （可选）—— 后处理排序 + top-N
  - ``warnings``        （可选）—— 简短中文字符串，解释模糊语义

硬性规则：
  1. ``"asof"`` 一律使用绝对日期 ``{asof}``。**绝不**写 ``"today"`` / ``"今天"``。
  2. **关键** —— 所有 ``days`` 参数都以**交易日**为单位，绝不是日历天。
     A 股大约每周 5 个交易日、每月 ~20 个、每年 ~240 个。当用户提到日历
     区间（``一年 / 一个月 / 三个月 / N 天 / N 周``）时，**必须自行换算**
     为整数交易日数后再输出。**不要**直接传日历天数。
     换算表：
       * 一日 / 1 天      → 1
       * 一周 / 5 个交易日 → 5
       * 半个月           → 10
       * 一个月           → 20
       * 三个月 / 一季度  → 60
       * 半年             → 120
       * 一年 / 近一年    → 240
       * 两年             → 480
     用户显式给出 ``X 个交易日`` 时，按字面值传 X。
  3. 优先使用预计算列 ``ma5/ma10/ma20/ma60``，而不是泛用 indicator。
  4. 默认使用 ``close_qfq``（前复权）；仅当用户明确说"不复权"时才用 ``close``。
  5. 涉及 ST / 北交所 / 上市天数 / 行业的条件归 ``universe_plan``，**不要**
     塞进 ``screen_plan``。
  6. Top-N / 排序（"前 N"、"排序"）放在 ``rank``，**不要**放进 predicate。
  7. **绝不**编造未定义的 op 或字段。Schema 是封闭的。以下示例是**绝不**
     允许出现的：``mul`` / ``div`` / ``add`` / ``sub``（不支持标量算术）、
     ``between``（用 ``and(gte, lte)``）、predicate 内嵌的 ``rank``（用
     顶层 ``rank``）、``pe`` / ``market_cap`` / ``circ_mv`` / ``listing_age``
     （用 ``listed_days``）、``last_n``（用窗口聚合替代）。
  8. 即使措辞松散，也要尽可能映射到封闭 Schema，**不要**随便丢弃条件。
     看上去不支持但实际可表达的例子：
       * ``介于 a 到 b 之间``         → ``and(gte a, lte b)``
       * ``近 N 天内某天 X``           → ``exists`` 窗口 N predicate X
       * ``连续 N 天 X``               → ``consecutive min_len=N`` predicate X
       * ``全部 / 每天 / 都 X``        → ``for_all`` 窗口 predicate X
       * ``X 高于 Y 的 N%`` 当 N=100   → ``gt(X, Y)``（100% 是恒等）
       * ``突破 N 日新高``             → ``gt(close_qfq, max-agg over N)``
     **只有**在确实没有合法 DSL 形式时才丢弃；以下场景**必须**丢弃 + 在
     ``warnings`` 中说明（且也只有这些场景，其它情况都要再想想）：
       * ``股价高于 N 月最高价的 K%`` 当 K != 100  —— 需要标量乘法
       * ``流通市值 / 总市值 / 市值``    —— 没有市值字段
       * ``市盈率 / PE / PB / ROE``      —— 没有基本面字段
       * ``RSI / MACD / KDJ / BOLL``     —— 只有 ma5/ma10/ma20/ma60
     正确翻译永远好过丢弃。
  9. ``实际换手率`` 与 ``turnover_rate`` 是同一列，**不要**捏造另一字段。
 9a. 行业术语在 ``universe_plan`` 中的标准映射（除非用户给出自己的阈值，
     否则用下面这些）：
       * ``ST`` / ``*ST`` / ``st``       → ``is_st = false``
       * ``北交所`` / ``北交``           → ``code not_starts_with`` 之一：``"8"`` / ``"4"`` / ``"920"``
       * ``新股`` / ``次新股``           → ``listed_days >= 90``
       * ``上市超过 N 个月``             → ``listed_days >= N*30``
       * ``上市超过一年``                → ``listed_days >= 365``
 10. 闭区间 ``介于 a 到 b 之间`` → 输出 ``and(gte, lte)``，**不要**用 ``between``
     （该 op 不存在）。

K 线字段（screen_plan）：{screen_fields}
Universe 字段（universe_plan）：{universe_fields}

K 线 op：
  逻辑：and / or / not
  比较：gt / lt / gte / lte / eq / neq
  窗口断言：for_all / exists / consecutive
  标量：{{field: ...}}、{{const: <number>}}、
        {{agg: mean|sum|min|max|count, field: ..., window: {{days: N}}}}、
        {{period_return: {{days: N}}}}、
        {{indicator: "ma", field: ..., period: 5|10|20|60}}

Universe op：
  逻辑：and / or / not
  比较：gt / lt / gte / lte / eq / neq / contains / starts_with / not_starts_with
  常量：字符串、ISO 日期（YYYY-MM-DD）、数字、布尔（仅 is_st）

Rank 形态：
  {{ "metric": <Scalar>, "order": "asc" | "desc", "top_n": int|null }}

示例：

[Q] 最近5天每天股价都高于ma5
[A] {{
  "screen_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "for_all",
      "window": {{"days": 5}},
      "predicate": {{
        "op": "gt",
        "left":  {{"field": "close_qfq"}},
        "right": {{"field": "ma5"}}
      }}
    }}
  }}
}}

[Q] 最近10天平均换手率小于10%
[A] {{
  "screen_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "lt",
      "left":  {{"agg": "mean", "field": "turnover_rate", "window": {{"days": 10}}}},
      "right": {{"const": 0.10}}
    }}
  }}
}}

[Q] 最近20天涨幅大于30%, 剔除ST和北交所, 按近10日涨幅取前20
[A] {{
  "screen_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "gt",
      "left":  {{"period_return": {{"days": 20}}}},
      "right": {{"const": 0.30}}
    }}
  }},
  "universe_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "and",
      "args": [
        {{"op": "eq",              "left": {{"field": "is_st"}},    "right": {{"const": false}}}},
        {{"op": "not_starts_with", "left": {{"field": "code"}},     "right": {{"const": "8"}}}},
        {{"op": "not_starts_with", "left": {{"field": "code"}},     "right": {{"const": "4"}}}},
        {{"op": "not_starts_with", "left": {{"field": "code"}},     "right": {{"const": "920"}}}}
      ]
    }}
  }},
  "rank": {{
    "metric": {{"period_return": {{"days": 10}}}},
    "order": "desc",
    "top_n": 20
  }}
}}
"""


def build_nl_to_dsl_system_prompt(asof: date) -> str:
    """NL→DSL 的 system prompt（中文）。

    Args:
        asof: 绝对参考日期；prompt 中的 ``"today" / "今天"`` 一律换算到此日期。

    Returns:
        填充后的 system prompt 字符串。
    """
    return _NL_TO_DSL_SYSTEM_PROMPT_TEMPLATE.format(
        asof=asof.isoformat(),
        screen_fields=_SCREEN_FIELDS,
        universe_fields=_UNIVERSE_FIELDS,
    )
