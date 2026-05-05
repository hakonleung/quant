# Orchestration — 后台编排

## 功能

- Cron 定时拉取（meta 全量 + kline 增量）。
- 内存任务队列：限流 + 去重 + 重试，避免对 akshare / LLM 打爆。
- 暴露队列状态接口给前端（健康面板）。

## 实现

| 组件 | 位置 | 说明 |
| ---- | ---- | ---- |
| Cron | `apps/api/src/modules/orchestration/cron.orchestrator.ts` | 启动时注册 schedule，盘后跑 meta + kline |
| Queue | `apps/api/src/modules/orchestration/domain/in-memory-queue.ts` | 进程内 FIFO + 并发上限 + 失败退避 |
| Workers | `kline-worker.ts`、`meta-worker.ts` | 出队 → Arrow Flight 调 Python ops |
| Inspector | `cache-inspector.ts` | 巡检 Parquet 健康度（schema 版本 / 行数 / mtime） |
| Status API | `queue-status.controller.ts` | `GET /queue/status` 给 `feat-sys-stat` 用 |

## 设计取舍

- **不用 Redis/BullMQ**：v1 单机够用；进程重启 = 队列清零，靠 cron 兜底。
- **任务幂等**：所有 worker 都重读水位 → 只补缺失，重启 / 重试无副作用。
- **限流**：akshare 全局 5 QPS，LLM 按 provider 配额（在 adapter 内 token bucket）。
- **失败**：指数退避 ≤ 3 次；超限写日志 + 进入 `tasks.json` 死信区段。

## 缓存策略

- **队列状态**：进程内存为准，定期 dump 到 `data/watch/tasks.json` 用于排障。
- **巡检**：cache-inspector 不修复，只报告，由前端面板提示用户决定是否触发 sync。
