# LLM Providers

## 用途

- NL → DSL 翻译（`/screen` 路径，`apps/api/src/modules/screen/nl-to-dsl.service.ts`）
- 个人账本 AI 复盘（`/analyze` 路径，`apps/api/src/modules/ledger/ledger.service.ts`）
- TA 单股 + 板块分析（`/api/ta/analyze_one` + `/api/ta/analyze_many`，`apps/api/src/modules/ta/ta.service.ts`）
- 新闻舆情单股 + 多股聚合（`/api/sentiment/*`，`apps/api/src/modules/sentiment/news-sentiment.service.ts`）
- `/agent` 多步循环 + tool-use + 流式收尾（`apps/api/src/modules/agent/agent.service.ts`）

全部使用 **OpenAI 兼容 API**。**NestJS 是 LLM 客户端的唯一归属位**（CLAUDE.md §2.1） —
Python 进程现已**完全无 LLM**：`services/py/quant_io/llm/` + `quant_core/ports/llm_client.py`

- `quant_core/prompts/` 全部删除，`quant_rpc/main.py` 不再构造任何 LLM 客户端。

## NestJS 适配器（`apps/api/src/modules/llm/`）

| 文件                                   | 说明                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `llm.service.ts`                       | 统一入口；`chatWithTools` / `chatStreamFinalize` / `completeJson` / `completeWithWebSearch` / `completeJsonWithWebSearch`；按 scope 解析 provider + 写 ledger |
| `llm.config.ts`                        | env loader：默认 `LLM_*` + 可选 `AGENT_LLM_*` 覆盖                                                    |
| `providers.ts`                         | 静态 catalog（Qwen / DeepSeek / Moonshot），含 `webSearchKind` + 每千 token CNY 单价                  |
| `adapters/openai-compatible.client.ts` | `openai` SDK 包装，三种调用形式 + tool-use + 流式                                                     |
| `web-search/moonshot-tool-loop.ts`     | Kimi `$web_search` builtin_function 工具循环（硬上限 4 次）                                           |
| `web-search/qwen-extra-body.ts`        | DashScope `extra_body.enable_search` 单次流式                                                         |
| `ports/llm-client.port.ts`             | `LlmClient` 抽象接口                                                                                  |
| `ledger/user-llm-ledger.store.ts`      | `UserScopedJsonStore<UserLlmLedger>` — `data/users/{userId}/llm-ledger.json` append-only 流水         |
| `ledger/llm-ledger.recorder.ts`        | fire-and-forget 切面，每次 LLM 调用结束（含失败）写一行                                               |

`/usr` 指令读取该 ledger，给出今日 / 本月 / 累计 CNY + per-scope 拆分。

## 已验证 provider（NestJS catalog 顺序）

| Provider        | model_pro         | web_search                 | API key env        |
| --------------- | ----------------- | -------------------------- | ------------------ |
| Qwen / 通义     | `qwen-plus`       | `extra_body.enable_search` | `QWEN_API_KEY`     |
| DeepSeek        | `deepseek-v4-pro` | —                          | `DEEPSEEK_API_KEY` |
| Moonshot (Kimi) | `kimi-k2.6`       | `$web_search` 工具循环     | `MOONSHOT_API_KEY` |

解析顺序：① `LLM_PROVIDER` / `AGENT_LLM_PROVIDER` 显式指定 → ② 第一条 catalog 中环境里有 key 的（need-web-search 时筛掉无 webSearchKind 的）。`AGENT_LLM_*` 覆盖位仅当 scope = `'agent'` 生效。

## 调用规约

- **结构化输出**：`response_format: 'json_object'`（含 `completeJsonWithWebSearch` 路径——Qwen `enable_search` + Moonshot 工具循环均透传）。所有 JSON prompt 强制 **单行 minified** 输出 + 字段字数上限；解析失败**不重试**，直接抛 `LLM_FAILED` / `NL_TRANSLATION_FAILED` / `DSL_INVALID`。
- **工具调用**：`/agent` 走 `chatWithTools` + 注册指令暴露成 `ChatTool[]`；模型 emit `tool_calls` → `InstructionExecutor.execute`；`costsCredits` / `destructive` 工具中途暂停等待用户确认（参见 `docs/modules/15-instructions.md`）。
- **超时**：`LLM_REQUEST_TIMEOUT_MS`（默认 60s）；Moonshot 工具循环单轮 240s 上限。
- **token 计费**：每次调用结束写 `UserLlmLedgerEntry`，含 `provider / model / scope / usage / cnyCost / durationMs / ok / traceId`。
- **不缓存原始 LLM 响应**：缓存发生在业务层（参见 `docs/modules/05-sentiment.md`、`docs/modules/13-ledger.md`）。
- **结构化日志**：`llm_call_ok` / `llm_call_fail` 日志必含 `provider model scope usage_in usage_out usage_total duration_ms trace_id user_id`（CLAUDE.md §1.4）。
