# Watch — 自选盯盘

## 功能

- 用户维护若干"盯盘宇宙"（自选清单）。
- 实时（盘中分钟级）刷新行情，触发 hit 条件 → 边沿触发推送（避免重复打扰）。
- 形态 / 价格 / 涨跌幅 / 量能等条件可叠加。

## 实现

| 层 | 位置 | 说明 |
| -- | ---- | ---- |
| Types | `quant_core/domain/types/watch.py` | `WatchEntry`、`WatchHit`、`WatchStatus` |
| Source | `quant_io/sources/akshare_watch.py` | `stock_us_hist_min_em` 等盘中接口（带 start/end 窗口，commit d26d170） |
| Service | `quant_core/services/watch_quote_service.py` | 拉行情 + 评估 hit |
| Cache | `quant_cache/file_kv_store.py` | 报价快照 KV + hit 状态（边沿对比，commit e3d77be：match ≠ hit） |
| RPC | `quant_rpc/ops/watch.py` | Arrow Flight |
| API | `apps/api/src/modules/watch/` | `GET /watch/quotes`、`POST /watch/refresh` |
| Notify | `quant_io/notify/slack_webhook.py` | hit 边沿触发时投递 |
| Web | `feat-watch-live` | 实时表格 + 状态徽标 |

## 缓存策略

- **宇宙列表**：`data/watch/universe_*.json`（手工编辑或 UI 导入）。
- **任务状态**：`data/watch/tasks.json`（NestJS in-memory queue 持久化快照）。
- **报价快照 / hit 状态**：`file_kv_store` 文件 KV，每 key 一文件 + envelope（含 `expires_at`）。
- **边沿语义**：`match`（条件成立）与 `hit`（首次成立 → 触发通知）严格区分；状态从 false → true 才发通知，避免连发。
