# Orchestration — 后台编排

## 功能

- Cron 定时拉取（meta 全量 + kline 增量）。
- 内存任务队列：限流 + 去重 + 重试，避免对 akshare / LLM 打爆。
- 暴露队列状态接口给前端（健康面板）。

## 实现

| 组件        | 位置                                                           | 说明                                                                                |
| ----------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----- | --------- | ---- |
| Cron        | `apps/api/src/modules/orchestration/cron.orchestrator.ts`      | 自实现 setTimeout 调度（无 `@nestjs/schedule`）；BJT 15:15 触发，冷启动不自动扫描   |
| Queues      | `apps/api/src/modules/orchestration/domain/in-memory-queue.ts` | 进程内 FIFO + 并发上限 + 失败退避；MetaQueue / KlineQueue 各一条独立队列            |
| Workers     | `kline-worker.ts`、`meta-worker.ts`                            | 出队 → Arrow Flight 调 Python ops                                                   |
| Inspector   | `cache-inspector.ts`                                           | 巡检 Parquet 健康度（schema 版本 / 行数 / mtime），收集 meta + kline 修复任务       |
| Trigger API | `queue-status.controller.ts`                                   | `GET /api/orchestration/queue/status`（feat-sys-stat 用）+ `POST .../scan?kind=meta | kline | blacklist | all` |

## 设计取舍

- **不用 Redis / BullMQ**：v1 单机够用；进程重启 = 队列清零，靠 cron 兜底。
- **任务幂等**：所有 worker 都重读水位 → 只补缺失，重启 / 重试无副作用。
- **限流**：akshare 全局 5 QPS，LLM 按 provider 配额（在 adapter 内 token bucket）。
- **失败**：`RATE_LIMITED` / `SOURCE_UNAVAILABLE` 走指数退避（≤ 3 次）；超限写日志 + dump 到 `tasks.json` 死信区段。
- **Coalesce**：每个 kind 维护一个 in-flight Promise，避免手动触发与 cron 重叠时双跑。
- **Blacklist 优先**：`scan` kind = `blacklist` 或 `all` 时先调 `compute_ashare_blacklist` Flight op 写盘，meta / kline 子扫描随后才查询。冷启动首次 tick 之前 workers 行为不受过滤（详见 `12-blacklist.md`）。

## 缓存策略

- **队列状态**：进程内存为准，定期 dump 到 `data/watch/tasks.json` 用于排障。
- **巡检**：cache-inspector 不修复，只报告，由前端面板提示用户决定是否触发 sync。
