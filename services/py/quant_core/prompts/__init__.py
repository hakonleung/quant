"""集中式 prompt 仓库 — 所有面向 LLM 的 prompt 在此统一管理。

按照 CLAUDE.md §2.5.1 要求，prompt 是项目的核心资产之一：
* 与业务语义强耦合，不应散落在 service 文件里
* 调用方需要能够独立预览 / 复用 / 跨服务一致
* 支持 A/B 测试与版本演进时方便集中 diff

约定：

1. 所有 prompt **使用中文** 描述 — 项目所选 LLM（Kimi / DeepSeek 等）
   均为中文模型，中文 prompt 在指令遵从、结构化输出准确度上显著优于英文。
2. 每个子模块覆盖一个业务场景，导出 ``build_*_system`` /
   ``build_*_user`` 纯函数。函数体内只做字符串模板填充，不做 IO。
3. 函数签名只接受领域类型（``StockMeta`` / ``date`` / ...）或纯数据
   字符串；禁止依赖 service / adapter / settings。
4. prompt 文本中如果含有 ``{...}`` 文本占位（与字符串 format 冲突）必须
   双写为 ``{{...}}``。
"""

from quant_core.prompts.news_sentiment import (
    build_cluster_system_prompt,
    build_market_synth_system_prompt,
    build_stock_search_system_prompt,
    build_stock_search_user_prompt,
    build_stock_summarize_system_prompt,
    build_stock_summarize_user_prompt,
)
from quant_core.prompts.nl_to_dsl import build_nl_to_dsl_system_prompt
from quant_core.prompts.ta_prompts import (
    build_ta_system_prompt,
    build_ta_user_prompt,
)

__all__ = [
    "build_cluster_system_prompt",
    "build_market_synth_system_prompt",
    "build_nl_to_dsl_system_prompt",
    "build_stock_search_system_prompt",
    "build_stock_search_user_prompt",
    "build_stock_summarize_system_prompt",
    "build_stock_summarize_user_prompt",
    "build_ta_system_prompt",
    "build_ta_user_prompt",
]
