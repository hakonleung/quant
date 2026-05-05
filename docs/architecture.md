# 系统架构

## 1. 进程拓扑

```
┌─────────────┐  HTTP/JSON + SSE  ┌────────────┐  Arrow Flight (gRPC)  ┌────────────────┐
│ Next.js     │ ───────────────>  │ NestJS     │ ────────────────────> │ Python svc     │
│ apps/web    │ <───────────────  │ apps/api   │ <──────────────────── │ services/py    │
│ :3000       │                   │ :3001      │                       │ :8815 Flight   │
└─────────────┘                   └────────────┘                       └────────────────┘
                                        │                                      │
                                        │ in-memory                            │ akshare / OpenAI / Slack
                                        ▼ queue + cron                         ▼
                                  ┌────────────┐                       ┌────────────────┐
                                  │ orchestrator│                      │ data/ (Parquet │
                                  │ (Node 内)   │                      │ + JSON KV)     │
                                  └────────────┘                       └────────────────┘
```

| 进程       | 职责                                                              | 不做                              |
| ---------- | ----------------------------------------------------------------- | --------------------------------- |
| Next.js    | UI、SSR、用户交互                                                 | 调外部数据源 / LLM                |
| NestJS     | HTTP 路由、参数校验、cron + 内存队列、Arrow Flight client         | 重计算、调外部数据源、调 LLM      |
| Python svc | 数据拉取与缓存写入、筛选/形态/舆情计算、LLM 调用                  | 直接处理 HTTP（一律走 Arrow Flight）|

> v1 单机本地，`apps/api` 监听 `127.0.0.1`，无鉴权；任务队列内存实现（NestJS 进程内），重启即清空——长任务以幂等可重入设计。

## 2. 仓库结构

```
apps/
  web/             Next.js 14 (App Router) — UI
  api/             NestJS 10 — HTTP 网关 / 编排
packages/
  shared/          跨 app 共享类型 / zod / 错误（核心资产）
  ui/              React 共享组件（极薄）
services/
  py/
    quant_core/    domain + services + ports + adapters（核心资产）
    quant_io/      外部数据源 adapter（akshare、LLM、Slack）
    quant_cache/   Parquet / KV / DuckDB 读取
    quant_rpc/     Arrow Flight server + ops handlers
    tests/
proto/             跨进程契约（errors.json + codegen）
data/              本地缓存（gitignore）
docs/              工程文档（本目录）
```

模块依赖方向：
- Python：`rpc → services → domain`，`services → ports ← adapters(io/cache)`，`domain` 禁 IO。
- NestJS：`controller → service → ports ← adapters`，`domain/` 纯函数无装饰器。

## 3. 数据流（举例：自然语言筛选）

```
用户输入 → web POST /api/screen/nl
  → NestJS NlScreenController (zod 校验, 生成 trace_id)
  → Arrow Flight call: ops/nl_screen
    → quant_core.NlToDslService → LLM (OpenAI compat) → DSL JSON
  → Arrow Flight call: ops/screen
    → quant_core.ScreenService
       → ParquetKlineRepo (DuckDB 读取需要的列)
       → screen_eval 在 polars 上求值
    → 返回 RecordBatch（命中股票 + 证据）
  → NestJS → JSON → web 渲染
```

- 同步小调用（< 1MB）：HTTP/JSON。
- 列存大数据（K 线、筛选结果）：Arrow Flight。
- 长任务（cron 同步、形态扫描）：返回 `task_id`，前端轮询 / SSE 订阅。

## 4. 错误与追踪

- 统一错误码表 `proto/errors.json`，由 `proto/codegen/` 同时生成 Python `QuantError` 子类与 TS zod schema。
- 跨进程错误经 Arrow Flight 序列化（`packages/shared/src/rpc/flight-error.ts` 解码）。
- 入口生成 `trace_id` 透传到 Python，写入结构化日志。

## 5. 部署（v1）

| 组件     | 启动                                                    |
| -------- | ------------------------------------------------------- |
| web      | `pnpm --filter @quant/web dev`                          |
| api      | `pnpm --filter @quant/api dev`                          |
| python   | `uv run python -m quant_rpc`                            |

依赖：Node 20+ / pnpm 10 / Python 3.11 / uv。无 Redis、无外部 DB——纯文件缓存。

## 6. 技术栈

| 组件         | 版本 |
| ------------ | ---- |
| Next.js      | 14   |
| NestJS       | 10   |
| Chakra UI    | 3    |
| TanStack Query / Virtual | 5 / 3 |
| lightweight-charts | 4 |
| Python       | 3.11 |
| Polars       | 1.x  |
| DuckDB       | 1.x  |
| pyarrow      | 18+  |
| OpenAI SDK   | 2.x  |

升级走 RFC（`docs/rfcs/`）。
