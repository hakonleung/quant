# Orchestration — 后台编排

## 功能

- Cron 定时刷新（meta + kline 合并任务），BJT 16:00 触发；只入队，不内联跑业务。
- 内存任务队列引擎：并发上限 + 单任务 retry/backoff + **池级 backoff**（connect abort / http proxy 类错误 → 锁池 → 等在飞任务 drain → 等冷却 → 自动 resume）。
- 批次收尾：cron 或 `POST /scan` 触发的整批 meta + kline 消费完毕后，自动跑 blacklist 重算 + 全量 dynamic sectors 重算（[12-blacklist.md](./12-blacklist.md)）。零散 push（无 `batchId`）不触发收尾。
- 暴露队列状态接口给前端（健康面板）。

## 实现

| 组件         | 位置                                                           | 说明                                                                                                                                                  |
| ------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cron         | `apps/api/src/modules/orchestration/cron.orchestrator.ts`      | 自实现 setTimeout 调度（无 `@nestjs/schedule`）；BJT 16:00 触发，冷启动不自动扫描                                                                     |
| Queue engine | `apps/api/src/modules/orchestration/domain/in-memory-queue.ts` | 进程内 FIFO + 并发 + 去重 + `maxRetry` + `taskBackoff` + `poolBackoff` + terminal-event 订阅                                                          |
| Pool backoff | `apps/api/src/modules/orchestration/domain/pool-backoff.ts`    | 池级状态机：trip → pause → drain in-flight → cooldown → resume；连续失败指数退避，单次成功重置                                                        |
| Workers      | `kline-worker.ts`、`meta-worker.ts`                            | 单 job = 一个 code 的合并任务（见下表）                                                                                                               |
| Settler      | `apps/api/src/modules/orchestration/batch-settler.ts`          | 监听 meta + kline 队列的终止事件（含失败到上限），按 `batchId` 收尾 → blacklist refresh → dynamic sectors 全量重算                                    |
| Inspector    | `cache-inspector.ts`                                           | 巡检 stock_meta + kline 水位，输出每 code 是否需 `needBasic` / `needFinancials` / kline sync                                                          |
| Trigger API  | `queue-status.controller.ts`                                   | `GET /api/orchestration/queue` 快照（feat-sys-stat 用，实时走 Socket.IO `queue.snapshot`）+ `POST .../scan?kind=meta\|kline\|blacklist\|all` 手动触发 |

## BJT 16:00 收尾流程

```mermaid
flowchart TD
  Cron[BJT 16:00 cron] --> Scan[POST /scan?kind=all]
  Scan --> Meta[meta 队列<br/>5500 个 meta_pkg]
  Scan --> Kline[kline 队列<br/>5500 个 kline_pkg]
  Meta --> Settle[BatchSettler<br/>等 batchId 全部终止]
  Kline --> Settle
  Settle --> BL[blacklist refresh]
  BL --> FF[stock-fund-flow<br/>(DDE 主力净流入)]
  FF --> Sec[dynamic sectors 全量重算]
  Sec --> Bf[stock-metrics-backfill<br/>(WCMI 横截面打分)]
```

## Job 包

每 code 一个合并任务，对应队列各一种 kind。任务 `batchId` 由 16:00 cron / 手动 scan 注入；ad-hoc push 不带 `batchId`，不进收尾计数。

| Job         | 子步骤（按序）                                                                               | 备注                                                    |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `meta_pkg`  | `enrich_stock_meta_for_code` ↑ `needBasic` / `enrich_financials_for_code` ↑ `needFinancials` | 旗标由 inspector 计算；黑名单 A 股 worker 内直接 return |
| `kline_pkg` | `sync_kline_for_code` → `upsert_stock_metrics_for_code`（best-effort）                       | metrics 落 `ret_*` / `ma*` 投影，失败仅 warn            |

## 队列参数（默认）

| 队列            | 并发 | maxRetry | taskBackoff          | poolBackoff（connect abort / proxy） |
| --------------- | ---- | -------- | -------------------- | ------------------------------------ |
| meta            | 8    | 3        | 1s → 5min, ×2, j0.2  | 5s → 5min, ×2, j0.2                  |
| kline           | 8    | 3        | 5s → 15min, ×2, j0.2 | 5s → 5min, ×2, j0.2                  |
| watch (a/hk/us) | 8    | 3        | 1s → 30s, ×2, j0.2   | 3s → 30s, ×2, j0.2                   |

Pool 错误分类器统一在 `apps/api/src/adapters/flight/flight-errors.ts`（`isPyFlightDown` ∪ `isTransportError`）。

## 设计取舍

- **不用 Redis / BullMQ**：v1 单机够用；进程重启 = 队列清零，靠 cron 兜底。
- **任务幂等**：所有 worker 都重读水位 → 只补缺失，重启 / 重试无副作用。
- **限流模型**：单任务 transient（`RATE_LIMITED` / `SOURCE_UNAVAILABLE`）由 `taskBackoff` 走指数退避至 `maxRetry`；连接级（ECONNRESET / proxy abort）由 `poolBackoff` 锁池，避免在通道不健康时浪费重试。
- **Coalesce**：每个 scan kind 维护一个 in-flight Promise，避免手动触发与 cron 重叠时双跑。
- **Blacklist 收尾**：不再在 scan 开场跑；改为 batch 结束后 BatchSettler 触发，让本批的 meta / kline 用前一日 blacklist，新结果流入次日批次（详见 `12-blacklist.md`）。
- **失败计入终止**：worker 用尽 retry 仍失败 → 队列发 `failed` 终止事件 → 收尾照常推进，避免单个 poison code 挂住整批。

## 缓存策略

- **队列状态**：进程内存为准；Socket.IO `queue.snapshot` topic 1Hz 推送给前端面板。
- **巡检**：cache-inspector 不修复，只输出待办，交给 cron / 手动 scan 入队。
