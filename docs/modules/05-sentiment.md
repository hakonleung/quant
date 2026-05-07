# Sentiment — 新闻舆情

## 功能

- **Stock-level**：给定股票代码，调用 LLM web_search 抓取近期新闻 → 输出主题、情绪、关键事件。
- **Market-level**：给一批股票 → 综合输出板块倾向 / 竞争格局。

## 实现

| 层         | 位置                                                      | 说明                                                                               |
| ---------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Types      | `quant_core/domain/types/sentiment.py`                    | `StockSentiment`、`MarketSentiment`、主题、趋势                                    |
| Service    | `quant_core/services/news_sentiment_service.py`           | 单次 LLM 调用（带 web_search 工具）+ 结构化输出                                    |
| Prompt     | `quant_core/prompts/sentiment_*.md`                       | system prompt + few-shot                                                           |
| LLM client | `quant_io/llm/openai_compatible.py`、`deepseek_client.py` | OpenAI-compat（Kimi / DeepSeek / 通义）                                            |
| Cache      | `quant_cache/parquet_sentiment_cache.py`                  | 按 `(code 或 codes_hash, run_date)` 写入 Parquet                                   |
| RPC        | `quant_rpc/ops/sentiment.py`                              | 见下表                                                                             |
| API        | `apps/api/src/modules/sentiment/`                         | `GET/POST /api/sentiment/analyze_one`、`/analyze_many`（cache 读 + paid 写各一路） |
| Web        | `feat-ai-out`、`feat-ai-md`、`feat-ai-hist`               | 渲染 markdown + 市场层快照                                                         |

## Flight ops

| op                             | 用途                    |
| ------------------------------ | ----------------------- |
| `get_cached_stock_sentiment`   | 仅读缓存，不打 LLM      |
| `analyze_one_stock_sentiment`  | 强制刷新（paid）—— 单股 |
| `get_cached_market_sentiment`  | 仅读缓存（多股聚合）    |
| `analyze_many_stock_sentiment` | 强制刷新（paid）—— 多股 |

## 缓存策略

- **粒度**：单股按 `code`，市场按对 codes 排序后的 SHA1 hash。
- **TTL**：2 个交易日（避免重复打 LLM 与 web_search 配额）。
- **失效**：写入时带 `run_date`，读取时若 `today - run_date >= 2` 视为过期回源。
- **异常**：LLM 输出无法 parse → 不写缓存，抛 `LLM_BAD_OUTPUT`。
- **存储**：`data/sentiment/<kind>/*.parquet`，schema 版本字段做演进。
