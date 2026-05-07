"""Prompt templates for the ``ta`` (technical analysis, beta) feature.

The system prompt pins the output JSON shape; the user prompt embeds a
compact CSV of the last ≤ 90 daily bars (qfq OHLCV + pre-computed MAs).
We deliberately avoid fundamentals / news so the model stays focused on
price-action reasoning.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date as date_cls

    from quant_core.domain.types.kline import DailyBar
    from quant_core.domain.types.stock import StockMeta


_SYSTEM_PROMPT = """\
你是一名专注于 A 股短中线的纯量价/图形技术分析师。

输入是一只股票最近不超过 90 个交易日的日线数据（前复权价 + 预计算的 \
MA5/10/20/60 + 成交量）。请只基于这些价量数据进行分析；**不要**\
编造基本面、新闻、公司事件、宏观政策等信息。

输出必须是单个合法 JSON 对象，结构如下，不要额外文字、不要 markdown 包裹：

{{
  "support_levels": [          // 支撑位，从最近到最远排序，最多 5 个
    {{
      "price": "12.34",        // 字符串形式的小数（前复权价坐标系，与输入一致）
      "strength": "weak" | "medium" | "strong",
      "reason": "简明中文，例：MA60 支撑+前期密集成交区"
    }}
  ],
  "resistance_levels": [...],  // 阻力位，从最近到最远排序，最多 5 个
  "trend": {{
    "direction": "up" | "down" | "sideways",
    "horizon_days": 5,         // 预测时间范围（交易日数），通常 5-20
    "confidence": 0.65,        // [0,1]
    "rationale": "简明中文走势依据"
  }},
  "patterns": ["三角整理", "MA60 上穿 MA20"],   // 0-5 个图形/技术形态
  "caveats": []                                // 可选：数据不足、停牌缺口等警告
}}

强约束：
1. price 字段必须是 **字符串形式的小数**（避免精度丢失），与输入价同精度。
2. confidence 必须是 0~1 的小数。
3. strength 取值仅限 weak/medium/strong；direction 仅限 up/down/sideways。
4. 支撑位价格应低于最新收盘价；阻力位应高于最新收盘价。允许极少数例外（突破后回踩），\
但需在 reason 中说明。
5. 不要在 patterns / caveats 中重复 trend.rationale 的内容。
"""


def build_ta_system_prompt() -> str:
    """System prompt fixing the JSON output shape for technical analysis."""
    return _SYSTEM_PROMPT


_BAR_HEADER = "date,open,high,low,close,volume,ma5,ma10,ma20,ma60"


def _format_decimal(value: object) -> str:
    """Render a Decimal/None as a compact CSV cell (empty for ``None``)."""
    if value is None:
        return ""
    return str(value)


def _format_bar(bar: DailyBar) -> str:
    return ",".join(
        (
            bar.trade_date.isoformat(),
            _format_decimal(bar.open_qfq),
            _format_decimal(bar.high_qfq),
            _format_decimal(bar.low_qfq),
            _format_decimal(bar.close_qfq),
            str(bar.volume),
            _format_decimal(bar.ma5),
            _format_decimal(bar.ma10),
            _format_decimal(bar.ma20),
            _format_decimal(bar.ma60),
        )
    )


def build_ta_user_prompt(
    *,
    meta: StockMeta,
    asof: date_cls,
    bars: Sequence[DailyBar],
) -> str:
    """User prompt: stock identity + CSV-encoded daily bars.

    The CSV uses qfq prices to match the pre-computed MAs; volume stays
    raw (front-adjusted volume is not stored on the row).
    """
    if not bars:
        body = "(no bars available)"
    else:
        rows = [_BAR_HEADER]
        rows.extend(_format_bar(b) for b in bars)
        body = "\n".join(rows)
    industries = meta.industries or ""
    return (
        f"股票: {meta.code} {meta.name}\n"
        f"所属行业: {industries}\n"
        f"分析基准日: {asof.isoformat()}\n"
        f"最近 {len(bars)} 个交易日数据 (CSV，价格为前复权):\n{body}\n"
    )
