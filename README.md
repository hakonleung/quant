# Quant

面向个人投资者的量化选股工作台 — 基于 K 线技术形态 + 舆情消息面，辅助决策中短期交易。

详见 [`docs/requirements.md`](docs/requirements.md) 与 [`docs/architecture.md`](docs/architecture.md)。
工程规约（最高指令）：[`CLAUDE.md`](CLAUDE.md)。

## 技术栈

- **Next.js 14** (App Router) — 前端
- **NestJS 10** — HTTP 网关 / 任务编排
- **Python 3.11** — 计算、LangGraph、数据 IO
- 跨进程：**Apache Arrow Flight (gRPC)** + **protobuf**
- 缓存：**Parquet + DuckDB**（v1）

## 前置环境

| 工具   | 版本下限 | 安装                                               |
| ------ | -------- | -------------------------------------------------- |
| Node   | 20.11    | <https://nodejs.org/> 或 `nvm install`             |
| pnpm   | 10       | `npm i -g pnpm@10`                                 |
| Python | 3.11     | `pyenv install 3.11`                               |
| uv     | 0.5+     | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

## 一次性 setup

```bash
# 安装两栈依赖
pnpm install
uv sync

# 复制环境变量模板（不会进 git）
cp .env.example .env
# 然后填入 LLM / 数据源的 API key
```

## 日常开发

```bash
# 前端开发服务（:3000）
pnpm --filter @quant/web dev

# 后端开发服务（:3001）
pnpm --filter @quant/api dev

# Python RPC 服务（:8814 gRPC + :8815 Flight）
uv run python -m quant_rpc.server   # 当 M4 完成后可用
```

## 跑测试 / 门禁

```bash
# 单栈
pnpm --filter @quant/web test:cov
pnpm --filter @quant/api test:cov
pnpm --filter @quant/shared test:cov
uv run pytest services/py/tests --cov=services/py

# 全量门禁（CI 必跑）
pnpm check
```

`pnpm check` 依次跑：

| Step | 命令                   | 检查内容                                |
| ---- | ---------------------- | --------------------------------------- |
| 1    | `prettier --check .`   | TS 格式                                 |
| 2    | `eslint .`             | TS lint（含 CLAUDE.md §1.2 全部硬规则） |
| 3    | `pnpm -r tsc --noEmit` | TS 类型                                 |
| 4    | `pnpm -r test:cov`     | TS 测试 + 覆盖率                        |
| 5    | `ruff format --check`  | Py 格式                                 |
| 6    | `ruff check`           | Py lint                                 |
| 7    | `mypy --strict`        | Py 类型                                 |
| 8    | `pytest --cov`         | Py 测试 + 覆盖率（≥ 90%）               |

任一步骤失败即非 0 退出。

## 仓库结构

```
apps/
  web/         # Next.js
  api/         # NestJS
packages/
  shared/      # 跨 app 共享类型 / zod / 错误（核心资产，禁 IO）
  ui/          # React 共享组件
services/
  py/          # Python compute / IO / cache / workflow / rpc
proto/         # 跨进程契约（M2 引入）
docs/          # 工程文档
data/          # 本地缓存（gitignore）
```

详见 [`docs/architecture.md`](docs/architecture.md)。

## 文档导航

| 文件                     | 用途                                            |
| ------------------------ | ----------------------------------------------- |
| `CLAUDE.md`              | 工程规约（**最高指令**）                        |
| `docs/requirements.md`   | 需求 / 用户故事 / 验收标准                      |
| `docs/architecture.md`   | 系统总览 + 部署拓扑                             |
| `docs/glossary.md`       | 术语表（量化 + 工程）                           |
| `docs/modules/0x-*.md`   | 模块详细设计（7 个）                            |
| `docs/integrations/*.md` | 集成层（缓存 / 数据源 / IPC / LangGraph / LLM） |
| `docs/rfcs/*.md`         | 重大设计提案（DSL / 增量更新 / 内存与 IPC）     |

## 开发流程

每次编码任务的强制步骤（详见 CLAUDE.md §0）：

1. 读相关文档，明确边界
2. 实现（按 §1 风格 + §2 模块化）
3. 调 `test-generator` 子代理生成测试
4. 调 `code-reviewer` 子代理 review
5. 交付汇报含变更清单 + 测试结果 + review 结论

跳过任何一步 = 任务未完成。
