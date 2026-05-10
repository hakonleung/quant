# 缓存策略

v1 全部本地文件，无 Redis、无外部数据库。所有缓存目录在 `data/`（gitignore）。

## 三种存储原语

| 原语                | 适用                                 | 实现                                                |
| ------------------- | ------------------------------------ | --------------------------------------------------- |
| **Parquet（列存）** | 大表：K 线、舆情、股票元             | `quant_cache/parquet_*.py`，DuckDB 读取             |
| **File KV**         | 小对象：报价快照、hit 状态、通知去重 | `quant_cache/file_kv_store.py`，每 key 一 JSON 文件 |
| **JSON 状态文件**   | 队列快照、watch 宇宙                 | `apps/api` 直接读写 `data/watch/*.json`             |

## 不变量

1. **写入原子**：`tempfile + os.replace`，永不中间态。
2. **写锁**：`filelock.FileLock(<path>.lock)`；读端无锁（依赖 OS 原子重命名）。
3. **schema 版本**：所有 Parquet 在 metadata 写 `schema_version`，启动时不匹配触发整文件重建（不是兼容写）。
4. **TTL via envelope**：file KV 在 value 旁带 `expires_at`（ISO8601 带 tz）；读取时过期判定 + 删除。
5. **核心资产纯净**：`quant_core/domain` 与 `packages/shared` 不直接 import 任何 cache 包——只通过 `ports/`。

## 各模块缓存一览

| 模块               | 路径                                  | 粒度                                                     | TTL / 失效                                                 |
| ------------------ | ------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| stock-meta         | `data/meta/stocks.parquet`            | 单文件全宇宙                                             | 手动 / BJT 15:15 cron 替换                                 |
| kline              | `data/kline/<code>.parquet`           | 一股一文件                                               | 增量（按 watermark）                                       |
| sentiment (stock)  | `data/sentiment/stock/{code}.json`    | 单股一文件（slim `Sentiment` view）                      | `(asof, windowDays)` 等值；asof 默认当日 UTC，跨日自动失效 |
| sentiment (market) | `data/sentiment/market/{hash}.json`   | 多股聚合；hash = sha256(排序后 codes)                    | 同上                                                       |
| ta                 | `data/ta/{code}.json`                 | 单股一文件（`TaAnalysis`）                               | `(code, asof)` 等值；asof = 最新一根 K 线日期              |
| sectors            | `data/sectors/*.json`                 | 单板块一文件（NestJS 持久化，commit d6af5b4）            | 手动编辑 / UI 写入                                         |
| sys-cfg            | `data/sys-cfg/*.json`                 | 单条配置一文件（dark mode / Slack webhook 等）           | 手动 / UI                                                  |
| blacklist          | `data/blacklist.json`                 | 单文件 `{codes, asof, universeSize, computedAt}`         | cron 每日 15:15 BJT 全量重算 (`12-blacklist.md`)           |
| watch tasks        | `data/watch/*.json`                   | 按 market 分组                                           | 进程内为准                                                 |
| watch quotes / hit | `data/_state/watch:<...>.json`        | FileKeyValueStore                                        | 盘中刷新覆盖                                               |
| notify dedupe      | `data/_state/notify:<sha>.json`       | 一事件一 KV                                              | 1 小时                                                     |
| llm ledger         | `data/users/{userId}/llm-ledger.json` | `UserScopedJsonStore` append-only；每次 LLM 调用一条记录 | 不过期（v1 仅展示，无配额上限）                            |

## 演进

字段新增 → 直接改 schema 写新版本 → 启动时检测旧版本数据，单文件触发重建。无双写期、无迁移脚本（v1 数据可重建）。
