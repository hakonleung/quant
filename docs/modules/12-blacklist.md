# Blacklist — A 股噪音过滤

## 功能

- 后端 cron 每日盘后基于已缓存的 `close_qfq` 计算"无趋势"A 股清单，写入 `data/blacklist.json`。
- 同步层（meta / kline workers）按清单收敛工作量；前端 `feat-sec-list` 用清单过滤合成的"全 A"sector。
- 用户搜索、watch、其他 sector 的 codes 列表不受影响——只过滤"全市场"那一面。
- v1 仅 A 股（沪深主板 + 创业板 + 科创板）；北交所 / HK / US 永远不进黑名单。

## 实现

| 层      | 位置                                                                      | 说明                                                               |
| ------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Compute | `services/py/quant_core/services/blacklist_service.py`                    | 纯函数 `compute_ashare_blacklist(meta_repo, kline_repo, clock)`    |
| RPC     | `services/py/quant_rpc/ops/blacklist.py`                                  | op `compute_ashare_blacklist` → `(code, asof, universe_size)` 表   |
| Service | `apps/api/src/modules/blacklist/blacklist.service.ts`                     | 调 op，写盘                                                        |
| Store   | `apps/api/src/modules/blacklist/blacklist.store.ts`                       | 内存缓存 + atomic 写 `data/blacklist.json`；提供 `has(code)`       |
| API     | `apps/api/src/modules/blacklist/blacklist.controller.ts`                  | `GET /api/blacklist` → `{ codes, asof, universeSize, computedAt }` |
| Cron    | `apps/api/src/modules/orchestration/cron.orchestrator.ts`                 | scan kind `blacklist`（included in `all`）；先于 meta/kline 跑     |
| Workers | `meta-worker.ts` + `cache-inspector.ts`                                   | 按 store 跳过 / 降频                                               |
| Helper  | `packages/shared/src/types/markets.ts` `isAShareCode(code)`               | 6 位前缀分流（`0` / `3` / `6` 是 A 股；`4` / `8` / `9` 是 BJ）     |
| Web     | `apps/web/lib/hooks/use-blacklist.ts` + `feat-sec-list/feat-sec-list.tsx` | TanStack Query 拉取，过滤"全 A" sector 的 codes                    |

## 入选规则

A 股 code 入黑名单当且仅当 **缓存 ≥ 21 行 K 线** 且 **以下三档区间收益率全部不达标**：

| 窗口（交易日） | 阈值（含上界则不入黑） |
| -------------- | ---------------------- |
| 20             | > 30 %                 |
| 90             | > 60 %                 |
| 250            | > 100 %                |

收益率 = `(close_today_qfq - close_n_ago_qfq) / close_n_ago_qfq`。

不足 21 行的 IPO / 长期停牌不进黑名单（无评判依据）。能评估到的窗口里只要任一过门即不进黑名单。

## 同步路径联动

| 路径                                 | 行为                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `meta-worker.ts: enrich`             | A 股 + 在黑名单 → 直接返回（不调 Flight）                                                            |
| `meta-worker.ts: enrich-financials`  | 同上                                                                                                 |
| `cache-inspector.findIncompleteMeta` | 黑名单 A 股从 incomplete 列表过滤掉                                                                  |
| `cache-inspector.findStaleKline`     | A 股 + 在黑名单：仅当 `lastDate == null` 或 `today - lastDate >= 10 calendar days` 时才入 kline 队列 |
| 非 A 股 / 非黑名单                   | 行为不变                                                                                             |

## 缓存策略

- **存储**：`data/blacklist.json`，schema 见 `BlacklistSnapshotSchema`（`packages/shared/src/types/blacklist.ts`）。
- **写入**：`atomicWriteJson`（`tempfile + os.replace`），单 mutex。
- **读取**：`BlacklistStore.snapshot()` 同步返回最近一次 load / replace 的内存副本；workers 直接 `has(code)`，不读盘。
- **冷启动**：文件不存在 ⇒ 视为空黑名单；首个 cron tick 写入后转入正常模式。
- **失效**：cron 每日 15:15 BJT 全量重算并替换；无单独的 TTL。
- **前端 stale**：TanStack Query 5 分钟 stale；首次加载前"全 A" sector 短暂未过滤，可接受。

## 调用规约

- 计算 op (`compute_ashare_blacklist`) 仅 cron 调用；HTTP 不暴露——避免用户串行触发耗时的全市场扫描。
- `GET /api/blacklist` 永远只读；写路径只在 cron 内。
