# 系统架构

## 1. 顶层视图

```
┌─────────────────────┐         HTTP/JSON + SSE          ┌─────────────────────┐
│   Next.js (web)     │ ───────────────────────────────> │   NestJS (api)      │
│   App Router        │ <─── token / SSE 进度流 ────────  │   gateway/orchestr. │
│   RSC + Client      │                                  │                     │
└─────────────────────┘                                  └──────────┬──────────┘
                                                                    │
                                                       Arrow Flight │ (gRPC)
                                                                    ▼
                                                         ┌─────────────────────┐
                                                         │  Python svc (rpc)   │
                                                         │  ┌───────────────┐  │
                                                         │  │ LangGraph     │  │
                                                         │  │ workflow      │  │
                                                         │  └──────┬────────┘  │
                                                         │         │           │
                                                         │  ┌──────┴────────┐  │
                                                         │  │ services/     │  │
                                                         │  │ compute/      │  │
                                                         │  │ io/ adapters/ │  │
                                                         │  └──────┬────────┘  │
                                                         └─────────┼───────────┘
                                                                   │
                                       ┌───────────────┬───────────┼─────────────┐
                                       ▼               ▼           ▼             ▼
                                  ┌────────┐     ┌────────┐  ┌──────────┐  ┌──────────┐
                                  │ tushare│     │akshare │  │ LLM API  │  │  Cache   │
                                  │  API   │     │  API   │  │(deepseek/│  │ (Parquet │
                                  │        │     │        │  │  kimi)   │  │ +DuckDB) │
                                  └────────┘     └────────┘  └──────────┘  │ +DuckDB) │
                                                                            └──────────┘
```

## 2. 进程职责

| 进程 | 主要职责 | **不做** |
|---|---|---|
| Next.js (`apps/web`) | UI 渲染、用户交互、SSE 接收进度 | 调外部 API、跑计算、调 LLM |
| NestJS (`apps/api`) | HTTP 路由、参数校验、调度 Python、缓存元数据查询 | 重计算、调外部数据源、调 LLM |
| Python svc (`services/py`) | 数据拉取与缓存写入、筛选/形态/舆情计算、LangGraph 编排、LLM 调用 | 直接处理 HTTP（一律走 Arrow Flight） |

## 3. 仓库结构

```
.
├── apps/
│   ├── web/                              # Next.js
│   │   ├── app/                          # App Router
│   │   ├── components/                   # 客户端组件
│   │   ├── lib/
│   │   │   ├── types/                    # 视图模型类型（核心资产）
│   │   │   └── fp/                       # 纯函数（formatter、selector）（核心资产）
│   │   ├── api-client/                   # 调 NestJS 的 typed client（生成）
│   │   └── __tests__/
│   └── api/                              # NestJS
│       ├── src/
│       │   ├── main.ts
│       │   ├── app.module.ts
│       │   ├── modules/
│       │   │   └── <feature>/
│       │   │       ├── <feature>.controller.ts
│       │   │       ├── <feature>.service.ts
│       │   │       ├── <feature>.module.ts
│       │   │       ├── dto/              # zod schema + 类型
│       │   │       └── domain/           # 该 feature 的纯类型 + 纯函数（核心资产）
│       │   ├── ports/                    # 抽象接口
│       │   ├── adapters/                 # ports 实现（含 ArrowFlightClient）
│       │   ├── common/                   # 守卫、拦截器、异常过滤器、Logger
│       │   └── config/                   # @nestjs/config + zod
│       └── test/
│
├── packages/
│   ├── shared/                           # 跨 app 共享（核心资产）
│   │   ├── types/                        # 共享 zod schema + 类型
│   │   ├── fp/                           # 共享纯函数
│   │   ├── errors/                       # 共享错误类
│   │   └── package.json
│   └── ui/                               # React 共享组件
│
├── services/
│   └── py/
│       ├── pyproject.toml                # uv 工作区
│       ├── quant_core/                   # 域 + 业务（核心资产）
│       │   ├── domain/
│       │   │   ├── types/                # 纯类型（@dataclass(frozen=True)）
│       │   │   ├── pure/                 # 纯函数
│       │   │   └── rules/                # 业务规则纯函数
│       │   ├── services/                 # 业务编排（依赖 domain + ports）
│       │   ├── ports/                    # Protocol / ABC
│       │   └── config/
│       ├── quant_compute/                # 计算密集（screening / pattern / sentiment）
│       ├── quant_io/                     # 数据源 adapters
│       ├── quant_cache/                  # 缓存 adapters
│       ├── quant_workflow/               # LangGraph
│       ├── quant_rpc/                    # Arrow Flight server
│       └── tests/
│
├── proto/                                # 跨进程契约（单一源）
│   ├── schemas/                          # Arrow schema (Python pyarrow.Schema 定义)
│   ├── messages/                         # protobuf 控制平面消息
│   ├── errors.proto                      # 错误码表
│   └── codegen/                          # 生成 TS zod + Python pydantic 的脚本
│
├── docs/                                 # 工程文档
│   ├── requirements.md
│   ├── architecture.md (本文件)
│   ├── glossary.md
│   ├── modules/
│   ├── integrations/
│   └── rfcs/
│
├── scripts/                              # 一次性脚本（数据回填、迁移、数据健康检查）
├── data/                                 # 本地缓存根（gitignore）
│   ├── meta/
│   ├── kline/
│   ├── news/
│   ├── reports/
│   └── _state/                           # 增量水位、死信队列
│
├── Makefile
├── pnpm-workspace.yaml
├── package.json
└── CLAUDE.md
```

**核心资产目录**（`apps/*/lib/types`、`apps/*/lib/fp`、`apps/api/src/**/domain`、`packages/shared`、`services/py/quant_core/domain`）受 CLAUDE.md §2.5.1 强约束保护，禁止 IO / 框架依赖。

## 4. 数据流（一次"自然语言筛选"端到端）

```
1. 用户在 Next.js 输入："最近5天股价都高于ma5"
2. Next.js POST /api/screen { nl_query: "..." }
   ↓ HTTP/JSON
3. NestJS ScreenController:
   a. zod 校验入参
   b. 生成 trace_id
   c. 调 ScreenService.run(query, trace_id)
4. ScreenService -> PyComputePort.translateAndRun(...)
   ↓ Arrow Flight (gRPC)
5. Python svc /rpc/screen 节点:
   a. NL → DSL：调 LLM（function calling），输出 DSL JSON
   b. DSL → 执行计划：编译为 Polars 表达式
   c. 从 Cache (Parquet) 读取需要的列（按需 + 列裁剪）
   d. 执行筛选，得到结果集（含命中证据列）
6. Python -> 返回 Arrow RecordBatch（结果表）
   ↓
7. NestJS 把 Arrow → JSON（小结果集）或留 task_id 走 SSE 流式返回
   ↓ SSE
8. Next.js 渲染表格 + 命中原因
```

## 5. 调用规约

- **同步小调用**（< 1MB 结果）：HTTP/JSON
- **大数据集**（K 线、新闻列表、筛选结果 > 1MB）：Arrow Flight Stream
- **长任务**（> 2s 计算、LangGraph 工作流）：返回 `task_id`，前端 SSE 订阅 `/api/tasks/:id/stream`
- **错误**：统一错误码（见 `proto/errors.proto`）+ `trace_id`

## 6. 部署拓扑（v1 单机本地）

- 三个进程通过 supervisord / pm2 管理
  - `next start` :3000
  - `nest start` :3001
  - `python -m quant_rpc.server` :8815（Arrow Flight 默认端口）
- 数据目录 `./data/` 本地存储，备份策略：每日 rsync 到外置硬盘 + 周度上云（用户自配）
- 配置通过 `.env`（gitignore），加载时 zod / pydantic 校验

## 7. 部署拓扑（v2 多机/上云预留）

- Web/API 分别 docker 化；Python 服务独立容器
- 缓存切换为 PostgreSQL + S3 (Parquet 对象存储)
- Arrow Flight 走内网；NestJS 在外网网关
- LLM API 经独立网关，限流 + 缓存

## 8. 技术栈版本约定

| 组件 | 选型 | 版本下限 |
|---|---|---|
| Node | LTS | 20.11+ |
| pnpm | | 9+ |
| Next.js | App Router | 14+ |
| NestJS | | 10+ |
| TypeScript | | 5.4+ |
| zod | | 3.23+ |
| Python | | 3.11+ |
| uv | | 0.4+ |
| Polars | | 1.x |
| DuckDB | | 1.x |
| pyarrow | | 17+ |
| LangGraph | | 0.2+ |
| pydantic | | 2.x |
| Arrow Flight | grpc | 1.6+ |

版本升级走 RFC，禁止悄悄升大版本。
