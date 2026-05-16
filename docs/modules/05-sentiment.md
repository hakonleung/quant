# Sentiment — 新闻舆情

## 功能

- **Stock-level**：给定股票代码，LLM 一次性 web_search + JSON 输出多维结构化分析（核心动因 / 题材 / 产品 / 价格信号 / 并购 / 供需 / 研报目标 / 竞争格局）+ 一段 ≤120字 brief「上涨核心动因分析」。
- **Market-level**：给一批股票 → 题材聚簇 + 板块综述 + 风格信号 + 行业趋势。

## 实现（NestJS）

| 层      | 位置                                                                   | 说明                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema  | `packages/shared/src/types/eqty.ts`（`Sentiment` / `MarketSentiment`） | 多维 typed schema：Insight / ThemeTag / ProductInfo / PriceSignal / ResearchTarget / Competitor / CompetitiveLandscape / StyleSignal / IndustryTrend                       |
| Wire    | LLM 输出：每条 `string[]` 是 `"|"`-分隔紧凑串                         | NestJS 解码 → typed object。每字段写死字数上限（drivers ≤30字、themes ≤8字、competitor.note ≤20字 等），超出会被裁；schema 详见 `prompts/sentiment.prompt.ts`             |
| Parser  | `apps/api/src/modules/sentiment/domain/pure/parsers.ts`                | 纯函数解码 wire 串；未知 enum / 空 key 返回 null（service 侧 drop 掉，不再向模型 echo 错误重试）                                                                            |
| Service | `apps/api/src/modules/sentiment/news-sentiment.service.ts`             | 单股一次 `LlmService.completeJsonWithWebSearch`（web_search + JSON 合一）。多股再叠加 cluster + market_synth 两次 `completeJson`（无 web_search）。**全部去重试**          |
| Format  | `packages/shared/src/fp/sentiment-format.ts`                           | `sentimentLines()` / `marketSentimentLines()` — 共享多段终端风格渲染，IM / FE / terminal 三处复用                                                                            |
| Cache   | `apps/api/src/modules/sentiment/sentiment-cache.store.ts`              | DuckDB parquet record store；TTL 30 天，schema 不兼容时静默视为 miss                                                                                                       |
| API     | `apps/api/src/modules/sentiment/sentiment.controller.ts`               | `GET/POST /api/sentiment/analyze_one`、`/analyze_many`；POST 走 `@CurrentUser` 给 LLM ledger 计费                                                                          |
| Web     | `feat-ai-eq` / `feat-ai-sec` / `feat-ai-md`                            | stdout 渲染 full 多段；AI.MD 子面板渲染 brief；`stock-dashboard` SentimentBlock 渲染 score + top theme/driver + brief                                                       |

## 缓存策略

- **粒度**：单股按 `code`，市场聚合按对 codes 排序去重后的 SHA-256。
- **TTL**：30 天滚动；过期或 schema 不兼容 → 视为 miss。
- **失效**：调用方传 `bypassCache=true` 或 `windowDays` 变化（multi-stock 的 codeHash 重算）。
- **异常**：LLM 输出无法 parse → 不写缓存，直接抛 `LLM_FAILED`（无重试，调用方可手动 `--fresh` 再试）。

## 性能基线（v2 改造）

- 单股端到端 LLM：2 次 → **1 次**（web_search + JSON 合并）。
- 输出 tokens：原 schema 2000-4000 → 极简 wire ~600-1000（**-60~70%**）。
- 去重试路径，长尾消除；典型 case 延迟约腰斩（详见提交 `perf(llm)`）。
