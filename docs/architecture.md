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
                                        ▼ queues + BJT cron                    ▼
                                  ┌─────────────┐                       ┌────────────────┐
                                  │ orchestrator│                       │ data/ (Parquet │
                                  │ (Node 内)   │                       │ + JSON KV)     │
                                  └─────────────┘                       └────────────────┘
```

| 进程       | 职责                                                                           | 不做                                 |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| Next.js    | UI、SSR、用户交互；`feat-term-main` 内嵌 xterm.js 终端宿主                     | 直接调外部数据源 / LLM               |
| NestJS     | HTTP 路由、参数校验、BJT 15:15 cron、内存队列、Arrow Flight client、Slack 推送 | 重计算、调外部数据源、调 LLM         |
| Python svc | 数据拉取与缓存写入、筛选 / 形态 / 舆情计算、LLM 调用                           | 直接处理 HTTP（一律走 Arrow Flight） |

> v1 单机本地，`apps/api` 监听 `127.0.0.1`，无鉴权；任务队列内存实现（NestJS 进程内），重启即清空——长任务以幂等可重入设计。

## 2. 仓库结构

```
apps/
  web/             Next.js 14 (App Router) — UI + xterm.js 终端宿主
  api/             NestJS 10 — HTTP 网关 / BJT cron / 内存队列
packages/
  shared/          跨 app 共享类型 / zod / 错误 / RPC stubs（核心资产）
  terminal/        @quant/terminal — 纯 TS 命令引擎（render / engine / widgets / actions / commands）
  ui/              React 共享组件（极薄）
services/
  py/
    quant_core/    domain + services + ports + adapters（domain = 核心资产）
    quant_io/      外部数据源 adapter（akshare、OpenAI-compat LLM）
    quant_cache/   Parquet repos / DuckDB 读取 / FileKeyValueStore
    quant_rpc/     Arrow Flight server + ops 注册表
    tests/
proto/             跨进程契约（errors.json + codegen）
data/              本地缓存（gitignore）
docs/              工程文档（本目录）
```

模块依赖方向：

- Python：`rpc → services → domain`，`services → ports ← adapters(io/cache)`，`domain` 禁 IO。
- NestJS：`controller → service → ports ← adapters`，`domain/` 子目录纯函数无装饰器。
- 终端包：`commands → actions / widgets / completion`，`widgets → render`，`engine` 不依赖 widgets / actions。

## 3. 数据流（举例：自然语言筛选）

```
用户输入 → web POST /api/screen/nl
  → NestJS NlScreenController（zod 校验 + 生成 trace_id）
  → Arrow Flight: nl_to_dsl
    → quant_core.NlToDslService → LLM (OpenAI-compat) → ScreenPlan JSON
  → Arrow Flight: screen_run
    → quant_core.ScreenService
       → ParquetKlineRepo（DuckDB 读取需要的列）
       → screen_eval 在 polars 上求值
    → 返回 RecordBatch（命中股票 + 证据）
  → NestJS → JSON → web 渲染
```

- 同步小调用（< 1MB）：HTTP/JSON。
- 列存大数据（K 线、筛选结果）：Arrow Flight。
- 长任务（cron 同步、形态扫描）：返回 `task_id`，前端走 SSE / 轮询；watch 实时流通过 `GET /api/watch/stream` SSE 推。

## 4. 终端通道（TERM.MAIN）

`packages/terminal` 是一个纯 TS / 无 DOM 的命令引擎；唯一的 React + xterm.js 宿主在 `apps/web/components/feat-term-main/`。引擎暴露 `DataActionRunner` 抽象：

- `MockActionRunner` — fixtures + LRU 缓存，离线可跑全部 UX。
- `LiveActionRunner` — 调真实 `/api/*` 端点，并通过 `REVALIDATE_AFTER` 表把 `analyze.{one,many}` / `sector.*` 等动作的副作用映射到 react-query queryKey 前缀 + zustand store，做跨缓存失效（参见 `docs/modules/10-terminal.md` §6）。

切换：`localStorage.setItem('tm.runner', 'mock')` → mock；移除即 live（默认）。

## 5. 错误与追踪

- 统一错误码表 `proto/errors.json`，由 `proto/codegen/` 同时生成 Python `QuantError` 子类与 TS 错误类 + zod schema。
- 跨进程错误经 Arrow Flight 序列化（`packages/shared/src/rpc/flight-error.ts` 解码）。
- 入口生成 `trace_id` 透传到 Python，写入结构化日志。
- 错误码空间：data 100–199、dsl 200–299、pattern 300–399、external 400–499、llm 500–599、cache 600–699、999 = INTERNAL。

## 6. 部署（v1）

| 组件   | 启动                           |
| ------ | ------------------------------ |
| web    | `pnpm --filter @quant/web dev` |
| api    | `pnpm --filter @quant/api dev` |
| python | `uv run python -m quant_rpc`   |

依赖：Node 20.11+ / pnpm 10 / Python 3.11 / uv 0.5+。无 Redis、无外部 DB——纯文件缓存。

## 7. 技术栈版本（实际）

| 组件                     | 版本   |
| ------------------------ | ------ |
| Next.js                  | 14.2   |
| React                    | 18.3   |
| NestJS                   | 10.4   |
| Chakra UI                | 3.x    |
| TanStack Query / Virtual | 5 / 3  |
| Apache Arrow (Node)      | 21.x   |
| @grpc/grpc-js            | 1.14.x |
| lightweight-charts       | 4.x    |
| Python                   | 3.11+  |
| Polars                   | 1.40+  |
| DuckDB                   | 1.5+   |
| pyarrow                  | 18+    |
| pydantic                 | 2.10+  |
| OpenAI SDK (Py)          | 2.x    |
| filelock                 | 3.16+  |

升级走 RFC（`docs/rfcs/`）。
