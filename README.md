# Quant

面向个人投资者的量化选股工作台 — 基于 K 线技术形态 + 舆情消息面，辅助决策中短期交易。

详见 [`docs/architecture.md`](docs/architecture.md)。
工程规约（最高指令）：[`CLAUDE.md`](CLAUDE.md)。

## 技术栈

- **Next.js 14** (App Router) + **Chakra UI 3** + **TanStack Query** — 前端
- **NestJS 10** — HTTP 网关 / cron + 内存队列编排
- **Python 3.11** — 计算 / 数据 IO / LLM 调用
- 跨进程：**Apache Arrow Flight (gRPC)**
- 缓存：**Parquet + DuckDB + 本地文件 KV**（v1 无 Redis、无外部 DB）
- 终端：`@quant/terminal` 纯 TS 命令引擎 + `feat-term-main` 的 xterm.js 宿主（CRT 风 `TERM.MAIN`）

## 前置环境

| 工具   | 版本下限 | 安装                                               |
| ------ | -------- | -------------------------------------------------- |
| Node   | 20.11    | <https://nodejs.org/> 或 `nvm install`             |
| pnpm   | 10       | `npm i -g pnpm@10`                                 |
| Python | 3.11     | `pyenv install 3.11`                               |
| uv     | 0.5+     | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

## 一次性 setup

```bash
pnpm install
uv sync

cp .env.example .env
# 填入 LLM provider 与 API key（akshare 无需 key；Slack webhook 可选）
```

主要 env 变量：

| 变量                                                     | 说明                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `QWEN_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` | provider key；catalog 顺序选第一个有 key 的                                                 |
| `LLM_PROVIDER` / `LLM_MODEL`                             | pin 默认 LLM 客户端的 provider / model（其它字段从 catalog 取）                             |
| `AGENT_LLM_PROVIDER` / `AGENT_LLM_MODEL`                 | `/agent` scope 专属覆盖（缺省回退默认）                                                     |
| `AGENT_MAX_TOOL_CALLS`                                   | `/agent` 单次循环最大工具调用次数（默认 5，clamp 1..10）                                    |
| `LLM_REQUEST_TIMEOUT_MS`                                 | 单次 LLM 请求超时（默认 60000，clamp 1..300_000）                                           |
| `INSTRUCTION_IM_ALLOWLIST`                               | 逗号分隔 sender id 白名单（如 `feishu:ou_a,slack:U_b`）；空 = 全开（**仅 dev**；prod 必填） |
| `QUANT_DATA_ROOT`                                        | 全局数据目录（默认 `../../data`，含 `users/{userId}/llm-ledger.json` 等用户态文件）         |

## 日常开发

```bash
# 前端 :3000
pnpm --filter @quant/web dev

# 后端 :3001
pnpm --filter @quant/api dev

# Python Arrow Flight :8815
uv run python -m quant_rpc
```

或一把启动：

```bash
./scripts/dev.sh                  # 前台跑全部，Ctrl-C 关闭（pnpm dev）
pnpm dev:start                    # 后台跑全部 + Redis；shell 立即返回
pnpm dev:status                   # 看每个服务的 PID / 存活
pnpm dev:stop                     # 一键关闭后台服务
pnpm dev:restart                  # = stop + start
```

后台模式日志写到 `.logs/{redis,py,api,web}.log`，pid 文件在 `.logs/<svc>.pid`。`--with-redis` 走脚本管理的本地 redis-server（依 `CHANNEL_REDIS_URL` 取端口）；如果你用 `brew services start redis` 自己管，去掉 `--with-redis` 即可。

## 跑测试 / 门禁

```bash
# 单栈
pnpm --filter @quant/web test:cov
pnpm --filter @quant/api test:cov
pnpm --filter @quant/shared test:cov
pnpm --filter @quant/terminal test:cov
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

## 仓库结构

```
apps/
  web/             Next.js 14（UI；feats + xterm.js 终端宿主）
  api/             NestJS 10（HTTP 网关 + BJT cron + 内存队列）
packages/
  shared/          跨 app 共享类型 / zod / 错误（核心资产，禁 IO）
  terminal/        @quant/terminal — 纯 TS 命令引擎 + 渲染 + 动作注册表
  ui/              React 共享组件
services/
  py/
    quant_core/    domain / services / ports / adapters（核心资产 = domain/）
    quant_io/      外部数据源 adapter（akshare、OpenAI-compat LLM、Slack）
    quant_cache/   Parquet repos + DuckDB 读取 + FileKeyValueStore
    quant_rpc/     Arrow Flight server + ops 注册表
proto/             跨进程契约（errors.json + codegen → Py / TS）
data/              本地缓存（gitignore）
docs/              工程文档
```

## 文档导航

| 路径                                  | 内容                                      |
| ------------------------------------- | ----------------------------------------- |
| `CLAUDE.md`                           | 工程规约（**最高指令**）                  |
| `docs/architecture.md`                | 进程拓扑 + 数据流 + 部署 + 版本           |
| `docs/glossary.md`                    | 术语表                                    |
| `docs/requirements.md`                | 需求 / 用户故事                           |
| `docs/modules/01-stock-meta.md`       | 股票元信息                                |
| `docs/modules/02-kline.md`            | K 线 + 预计算 MA / 前复权 + range 预设    |
| `docs/modules/03-screen.md`           | 选股 DSL + NL2DSL（解耦后双 op）          |
| `docs/modules/04-pattern.md`          | 形态匹配（DTW，全宇宙 + similarity rank） |
| `docs/modules/05-sentiment.md`        | 新闻舆情（LLM web_search，paid vs cache） |
| `docs/modules/06-watch.md`            | 自选盯盘（pct/abs 条件 + 边沿触发）       |
| `docs/modules/07-orchestration.md`    | BJT 16:00 cron + 内存队列（池级 backoff） |
| `docs/modules/08-frontend.md`         | 前端 Feat 框架 + Feat 列表                |
| `docs/modules/09-notifications.md`    | 通知（Slack 纯文本 mrkdwn）               |
| `docs/modules/10-terminal.md`         | `@quant/terminal` + `TERM.MAIN`           |
| `docs/modules/12-blacklist.md`        | A 股噪音黑名单（cron + sector-all 过滤）  |
| `docs/modules/15-instructions.md`     | 跨进程指令集 + `/agent` 自然语言入口      |
| `docs/integrations/data-sources.md`   | akshare 适配                              |
| `docs/integrations/llm-providers.md`  | LLM provider 抽象                         |
| `docs/integrations/ipc-py-ts.md`      | Arrow Flight 通信 + op 清单               |
| `docs/integrations/cache-strategy.md` | 文件缓存原语 + 不变量                     |
| `docs/rfcs/`                          | 历史 RFC（DSL / 增量 / IPC 设计）         |

## 开发流程

每次编码任务的强制步骤（详见 CLAUDE.md §0）：

1. 读相关文档，明确边界
2. 实现（按 §1 风格 + §2 模块化）
3. `test-generator` 生成测试 + `run-tests` 跑绿
4. 必要时调 `code-reviewer`
5. 文档同步：单次涉及多模块或 milestone 收尾时调 `doc-updater`（连续 5 个 commit 未碰 docs/ 也会自动提醒）
6. 交付汇报含变更清单 + 测试结果（+ review 结论）
