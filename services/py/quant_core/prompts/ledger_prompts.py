"""Prompt templates for the personal-ledger AI analysis.

The system prompt fixes the JSON shape; the user prompt embeds a CSV of
the last ≤ 30 entries (date / pnl_amount / closing_position /
closing_provided / cash_flow / daily_pct). We deliberately keep the
input narrow — pure P/L numbers — and explicitly forbid the model from
recommending tickers or fabricating market context.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.ledger import EnrichedLedgerEntry


_SYSTEM_PROMPT = """\
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

输出必须是单个合法 JSON 对象，结构如下，不要额外文字、不要 markdown 包裹：

{{
  "summary": "整段时间的盈亏与仓位画像（120 字以内）",
  "operation_style": "对操作风格的判断，如「波段为主，仓位浮动 40%~80%」",
  "market_view": "通过盈亏曲线反推的市场环境，如「上涨/震荡/下跌段，胜率约 X%」",
  "recommendations": [
    "1-3 条复盘建议；不涉及具体标的"
  ]
}}
"""


def build_ledger_system_prompt() -> str:
    """System prompt fixing the JSON output shape for ledger analysis."""
    return _SYSTEM_PROMPT


_HEADER = "date,pnl_amount,closing_position,closing_provided,cash_flow,daily_pct"


def _format_entry(entry: EnrichedLedgerEntry) -> str:
    return ",".join(
        (
            entry.date.isoformat(),
            str(entry.pnl_amount),
            str(entry.closing_position),
            "true" if entry.closing_provided else "false",
            str(entry.cash_flow),
            str(entry.derived_daily_pct),
        ),
    )


def build_ledger_user_prompt(entries: Sequence[EnrichedLedgerEntry]) -> str:
    """Render the entries as a CSV table inside a brief Chinese frame."""
    if len(entries) == 0:
        return "（账本为空）"
    body = "\n".join(_format_entry(e) for e in entries)
    return (
        f"以下是最近 {len(entries)} 个交易日的账本（CSV 表头先于数据，仅一行表头）：\n\n"
        f"{_HEADER}\n{body}\n"
    )
