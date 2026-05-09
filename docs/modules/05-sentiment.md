# Sentiment — 新闻舆情

## 功能

- **Stock-level**：给定股票代码，LLM web_search 抓取近期新闻 + flash 模型结构化抽取 → 输出主题、情绪、关键事件。
- **Market-level**：给一批股票 → 题材聚簇 + 板块综述 + 风格信号。

## 实现（NestJS）

| 层      | 位置                                                                | 说明                                                                                                              |
| ------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Schema  | `packages/shared/src/types/eqty.ts`（`Sentiment` / `MarketSentiment`） | 前端 view-model；slim 投影                                                                                        |
| Prompt  | `apps/api/src/modules/sentiment/prompts/sentiment.prompt.ts`        | 4 段中文 prompt：search / summarize / cluster / market_synth                                                      |
| Service | `apps/api/src/modules/sentiment/news-sentiment.service.ts`          | 三步管线：① web_search 分析师文（`LlmService.completeWithWebSearch`，scope=`sentiment`）→ ② flash JSON 抽取（`completeJson`，单次重试）→ ③ 单股缓存写回。多股再叠加 cluster + market_synth 两次 `completeJson` |
| Cache   | `apps/api/src/modules/sentiment/sentiment-cache.store.ts`           | 文件 KV：`data/sentiment/stock/{code}.json` 单股；`data/sentiment/market/{hash}.json` 多股聚合（hash = sha256 排序后 codes） |
| API     | `apps/api/src/modules/sentiment/sentiment.controller.ts`            | `GET/POST /api/sentiment/analyze_one`、`/analyze_many`；POST 走 `@CurrentUser` 给 LLM ledger 计费                  |
| Web     | `feat-ai-eq`、`feat-ai-md`、`feat-ai-sec`                            | 渲染 markdown + 市场层快照                                                                                        |

Python 端不再持有任何 sentiment 代码：`news_sentiment_service.py` / `parquet_sentiment_cache.py` / `quant_core/domain/types/sentiment.py` / `quant_rpc/ops/sentiment.py` / `quant_core/prompts/news_sentiment.py` 全部删除。

## 缓存策略

- **粒度**：单股按 `code`，市场聚合按对 codes 排序去重后的 SHA-256。
- **TTL**：以 `(asof, windowDays)` 为键的等值匹配 — `asof` 默认是请求时刻 UTC 当日，新一天到来时上一天的缓存自然失效（无需显式过期扫描）。
- **失效**：调用方传 `bypassCache=true` 或 enriched 签名变化（multi-stock 的 codeHash 重算）。
- **异常**：LLM 输出无法 parse → 不写缓存；单次重试后抛 `LLM_FAILED`。
- **存储**：JSON-per-key 文件，`tmp + rename` 原子写。Schema-validated 读，损坏文件视为 cache miss + 日志告警。
