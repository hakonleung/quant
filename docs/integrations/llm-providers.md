# LLM Providers

## 用途

- NL → DSL 翻译（screen 模块）
- 新闻舆情分析 + 主题归纳（sentiment 模块）

均使用 **OpenAI 兼容 API**，统一封装。

## 适配器

| 文件                                | 说明                                              |
| ----------------------------------- | ------------------------------------------------- |
| `quant_core/ports/llm_client.py`    | 抽象：`chat(messages, schema?, tools?) -> Result` |
| `quant_io/llm/openai_compatible.py` | 默认实现，支持流式 / 结构化输出 / web_search 工具 |
| `quant_io/llm/deepseek_client.py`   | DeepSeek 特化（rate limit / 工具语义微调）        |
| `quant_io/llm/providers.py`         | 工厂：从 `.env` 选 provider + 构造 client         |

## 已验证 provider

| Provider        | 模型            | 用途                                   | 备注            |
| --------------- | --------------- | -------------------------------------- | --------------- |
| Kimi (Moonshot) | `kimi-k2-*`     | sentiment 主路径                       | 内置 web_search |
| DeepSeek        | `deepseek-chat` | NL2DSL 主路径                          | 便宜稳定        |
| Qwen / 通义     | —               | 实验中（`scripts/try_qwen_search.py`） |                 |

切换通过 `.env` 中 `LLM_PROVIDER` + 对应 API key 完成；业务代码不感知。

## 调用规约

- **结构化输出**：用 JSON schema（pydantic）+ 二次 `model_validate` 校验；失败重试 ≤ 2 次再抛 `LLM_BAD_OUTPUT`。
- **超时**：请求 30s，工具调用 60s。
- **token 上限**：在 adapter 内按模型固定，超长 prompt 截断 + 警告日志。
- **不缓存原始 LLM 响应**：缓存发生在业务层（参见 `docs/modules/05-sentiment.md`）。
