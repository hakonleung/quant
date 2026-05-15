# Instructions — 跨进程指令集

## 功能

- 将「FE 命令面板 / term 命令 / IM 入站消息 / Socket 命令」四条历史路径统一到一套指令注册表语义之下。
- **共享层**只提供 id 命名规范、纯文本解析器、结果类型；**FE / BE 各自维护自己的注册表实例**。
- BE 端订阅 `channel.inbound`（Slack / Feishu）：匹配指令 → 执行 → 通过 `ChannelService.send` 把结果回推到同一频道，构成 IM 闭环。
- Socket 命令 `{ id, args }` 统一走同一个 `InstructionExecutor`，不再为每条命令单独写 schema 分支。

## 进程拓扑

```
                packages/shared/src/instructions/
                ┌────────────────────────────────────┐
                │  InstructionId 命名规范             │
                │  parseInstructionLine() 纯解析      │  ← 唯一的跨进程契约
                │  InstructionResult / formatResult    │
                └────────────────────────────────────┘
                        ▲                ▲
        ┌───────────────┘                └────────────────┐
        │                                                 │
   FE 实例（已存在，零改动）                          BE 实例（新增）
   packages/terminal/src/registry.ts                  apps/api/src/modules/instruction/
                                                      ────────────────────────────────
   feat-term-main 唯一入口；                          InstructionRegistry / Executor
   ⌘K → setAppMode('term')；                         InstructionImListener  ← @OnEvent('channel.inbound')
   命令面板已删除。                                   SocketInstructionAdapter ← SocketCommandHandler
                                                      handlers/* (built-ins)
                                                      <feature>/instructions/*.handler.ts
```

## 共享层（`packages/shared/src/instructions/`）

| 文件        | 内容                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id.ts`     | `InstructionId` 品牌类型 + `INSTRUCTION_ID_RE`（`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$`） + `instructionId(raw)` 校验                                                      |
| `parser.ts` | `parseInstructionLine(text, knownIds, { requirePrefix? })`：剥离 `/` 前缀（IM 模式）→ 切首 token → 校验 id 是否在 `knownIds` 中。**不做** zod 校验、不做 argv tokenize。 |
| `result.ts` | `InstructionResult = { ok:true, output:{ text } } \| { ok:false, error:{ code, message } }`；`formatResult(r)` 用于 IM 文本 / FE toast 的统一渲染。                      |
| `index.ts`  | re-export 上述三个模块                                                                                                                                                   |

**为什么共享层不放 spec 类型？** FE 的 `CommandSpec`（`@quant/terminal`）携带 tab 补全 + xterm 交互 widget；BE 的 `InstructionSpec` 用 zod argsSchema + Nest 注入的 service。两侧唯一可共享的是「id + summary + 参数 schema」，但 FE 现成 spec 没用 zod，强行统一会牵动 11 个命令文件，违反 §2.5.2 Rule of Three。

## BE 实例（`apps/api/src/modules/instruction/`）

| 文件                                           | 角色                                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instruction.spec.ts`                          | `InstructionSpec<TArgs> { id; summary; help?; argsSchema: z.ZodType<TArgs>; positional?; aliases? }`                                                                             |
| `instruction.port.ts`                          | `InstructionHandler<TArgs> { execute(args, ctx): Promise<InstructionResult> }`；`InstructionCtx = { traceId; source: 'im' \| 'socket' \| 'http'; channelId?; sender?; target? }` |
| `instruction.registry.ts`                      | `@Injectable()`：`register(spec, handler)` / `get(id)` / `list()` / `knownIds()`；alias → canonical id                                                                           |
| `instruction.executor.ts`                      | 两个入口：`execute(id, args, ctx)`（socket / http）和 `executeLine(line, ctx)`（IM）。zod 校验失败 → `{code:'validation'}`，handler 抛错 → `{code:'handler'}`                    |
| `instruction.provider.ts`                      | `InstructionRegistrarBase<TArgs>` —— 让 handler 类直接 extends，`onModuleInit` 自动注册                                                                                          |
| `instruction.im.listener.ts`                   | `@OnEvent(CHANNEL_INBOUND_EVENT)` → 解析 → 执行 → `ChannelService.send` 回推                                                                                                     |
| `parse-argv.ts`                                | `tokenize(rest)` + `parseArgvToObject(rest, positional)`：把首 token 后的字符串切成 `Record<string,string>`，支持 `k=v`、位置参数、`"..."` 引号转义                              |
| `socket-instruction.adapter.ts`                | 实现 socket gateway 的 `SocketCommandHandler` 接口，把 `{id, args}` 路由到 executor                                                                                              |
| `instruction.module.ts`                        | `@Global()` 模块；注入 `INSTRUCTION_CONFIG`、注册 `instruction.async` BullMQ 队列；导出 Registry / Executor / AsyncBus / Adapter；导入 ChannelModule                             |
| `instruction.config.ts`                        | env 驱动配置：`INSTRUCTION_IM_ALLOWLIST`（逗号分隔 sender id）+ `INSTRUCTION_DEBUG_ENABLED`（启用调试指令）                                                                      |
| `async/instruction-async.bus.ts`               | `instruction.async` 队列 + `INSTRUCTION_ASYNC_{STARTED,COMPLETED}_EVENT` 事件                                                                                                    |
| `async/instruction-async.processor.ts`         | BullMQ Worker；处理流程 = emit started → executor.execute → emit completed（同时打 socket 与 EventEmitter）                                                                      |
| `handlers/{help,ping,channel-echo}.handler.ts` | 内置 handler（ping / channel.echo 仅在 `INSTRUCTION_DEBUG_ENABLED=1` 时注册）                                                                                                    |

### v1 已注册指令

| Spec id            | 来源                                               | 模式      | 摘要                                                                                                                                              |
| ------------------ | -------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `help`             | `instruction/handlers/help.handler.ts`             | sync      | 列已注册 spec；`/help <id>` 显示详情                                                                                                              |
| `focus`            | `stock-meta/instructions/focus.handler.ts`         | sync      | 校验 6 位 A 股 code 并回 `focus = <code> <name> (<industry>)`                                                                                     |
| `stock`            | `stock-meta/instructions/stock.handler.ts`         | sync      | 按 code / 名称 / 拼音搜索（默认 limit=10）                                                                                                        |
| `sector`           | `sectors/instructions/sector.handler.ts`           | sync      | 列对当前用户可见的板块（own + published），输出包含 OWNER 与 [PUB] 标识                                                                           |
| `sector.publish`   | `sectors/instructions/sector-publish.handler.ts`   | sync      | `/sector.publish <id>` 仅创建者；触发 confirm 后置 `published=true` 让全员可见                                                                    |
| `sector.unpublish` | `sectors/instructions/sector-publish.handler.ts`   | sync      | `/sector.unpublish <id>` 仅创建者；恢复为私有                                                                                                     |
| `sector.refresh`   | `sectors/instructions/sector-refresh.handler.ts`   | sync      | `/sector.refresh <id>` 任何用户可触发；动态板块按 `screenPlan` 重跑并落库,所有人共享结果                                                          |
| `watch`            | `watch/instructions/watch.handler.ts`              | sync      | `watch list`（别名 `watch.list`）—— 列 watch 任务                                                                                                 |
| `ledger`           | `ledger/instructions/ledger.handler.ts`            | sync      | `/ledger [sub=list] [limit=N]`：基于 `LedgerService.enriched` 输出近 N 条（`sub=summary` 已下线，复盘走 `/ledger.analyze`）                       |
| `ledger.analyze`   | `ledger/instructions/ledger-analyze.handler.ts`    | **async** | `/ledger analyze [fresh=1]` `[$]`：调 `LedgerService.analyze`（LLM in NestJS），与 term 的 `analyze.ledger` 按钮等价；走 `instruction.async` 通道 |
| `analyze`          | `sentiment/instructions/analyze.handler.ts`        | **async** | `/analyze <code> [fresh=1] [windowDays=N]` `[$]`：单只新闻舆情，对齐 term `analyze.one`；async 通道                                               |
| `analyze.sector`   | `sentiment/instructions/analyze-sector.handler.ts` | **async** | `/analyze.sector <id> [fresh=1] [windowDays=N]` `[$]`：板块成员舆情扇出 + LLM 主题聚类，对齐 term `analyze.many`                                  |
| `ta`               | `ta/instructions/ta.handler.ts`                    | **async** | `/ta <code> [fresh=1]` `[$]`：单只技术分析，对齐 term `analyze.ta`                                                                                |
| `ta.show`          | `ta/instructions/ta-show.handler.ts`               | sync      | `/ta.show <code>` `[$]`：从缓存读已生成的 TA 分析（无 LLM 调用，仍走 confirm 流以与 `/ta` 一致）                                                  |
| `ta.sector`        | `ta/instructions/ta-sector.handler.ts`             | **async** | `/ta.sector <id> [fresh=1]` `[$]`：板块成员 TA 扇出 + LLM 综述，对齐 term `analyze.ta.many`                                                       |
| `web.search`       | `agent/instructions/web-search.handler.ts`         | sync      | `/web.search q="..." [n=5]`：仅给 `/agent` 工具集使用；锁定 Qwen 提供方做付费网搜，输出中文摘要                                                   |
| `update`           | `blacklist/instructions/update.handler.ts`         | sync      | `/update target=blacklist` `[!]`：调 `BlacklistService.refresh`，回 size/asof/universe                                                            |
| `screen`           | `screen/instructions/screen.handler.ts`            | **async** | `/screen "<NL>" [asof=YYYY-MM-DD]` `[$]`：NestJS 端 NL→DSL + Flight `screen_run`；走 async 通道                                                   |
| `agent`            | `agent/instructions/agent.handler.ts`              | sync      | `/agent <prompt>` `[$]`：自然语言总入口，多步 tool-use 循环 + 流式收尾；首次返回 `confirm-required` 让 IM 出付费卡，term 出 confirmPrompt         |
| `agent.confirm`    | `agent/instructions/agent-confirm.handler.ts`      | sync      | `/agent.confirm correlationId=… approve=1\|0`：续派被付费/破坏性工具暂停的循环；只接 `correlationId` 所属的同一 userId                            |
| `usr`              | `instruction/handlers/usr.handler.ts`              | sync      | 显示用户身份 + LLM ledger 累计（今日 / 本月 / 总计 + per-scope CNY）                                                                              |

#### 调试 / 内部指令（`INSTRUCTION_DEBUG_ENABLED=1` 才注册）

| Spec id        | 来源                                           | 用途                                                   |
| -------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `ping`         | `instruction/handlers/ping.handler.ts`         | echo args + traceId — 链路存活探针                     |
| `channel.echo` | `instruction/handlers/channel-echo.handler.ts` | 原样回推 args + ctx — 调 IM 鉴权 / 路由时用            |
| `channel.send` | `channel/instructions/channel-send.handler.ts` | 手动外发（socket / web term 触发）；prod IM 通常不需要 |

> `help` 输出只展示当前已注册的项；调试指令未启时不会出现在列表里。

### 文本语法

```
<id> [k=v ...] [positional ...]
```

- IM 端要求 `/` 前缀（避免普通聊天误触发）；term / socket 端不要前缀。
- **IM 兜底**：allowlist 内的 sender 发的裸消息（无 `/`，且不匹配任何已注册 id / 别名）会被自动路由到 `/agent q="<原文>"`；非 allowlist 仍沉默。
- **`InstructionSpec` 元数据**：`costsCredits=true`（外部付费 LLM）渲染为 `[$]`；`destructive=true`（不可逆写）渲染为 `[!]`。`/agent` 循环按这两个 flag 决定是否在工具调用前暂停等用户确认。
- **`InstructionResult.error.code`** 新增 `confirm-required`：付费指令在缺 `confirm` 时返回；IM 列表器把它映射成 `agent.paid_confirm` 卡 kind 而不是红色 error。
- `k=v` 对应 spec 的 zod 字段；位置参数按 `spec.positional` 顺序填入对应 key（已被 `k=v` 占用的 key 跳过）。
- 双引号包裹的值支持 `\"` 与 `\\` 转义；超过 `positional` 数量的多余位置参数静默丢弃，由 `argsSchema` 决定是否报错。

例：

- `/focus 600519` → `{ code: '600519' }`
- `/stock q=平安 limit=5` → `{ q: '平安', limit: 5 }`
- `/channel.send slack "hello world"` → `{ channel: 'slack', text: 'hello world' }`

## FE 实例

- 唯一权威是 `@quant/terminal` 的 `CommandRegistry`（`packages/terminal/src/registry.ts`），由 `feat-term-main` 用 `createDefaultRegistry()` 装载。
- 不引入 `InstructionSpec` 类型转译，也不复制一份注册表到 FE：term 命令的副作用本就在浏览器里发生，不需要往 BE 转。
- `apps/web/components/feat-cmd-palette/` 已**删除**。⌘K 全局快捷键直接 `setAppMode('term')`（参见 `apps/web/components/shell/app-shell.tsx`），顶栏新增 `TermTrigger` 替代旧的 palette chip。

## Socket 路径

- 共享 schema：`packages/shared/src/types/socket.ts` 的 `SocketCommandSchema = { id, args }`。
- gateway：`apps/api/src/modules/socket/socket.gateway.ts` 仍用 `SOCKET_COMMAND_HANDLER` 注入，`AppModule` 把 `SocketInstructionAdapter` 通过 `SocketModule.forRoot` 接进去。
- 加新指令 = 写一个继承 `InstructionRegistrarBase` 的 handler，列入 feature module 的 `providers`。**不需要**改任何 schema / gateway / adapter。

## ACL（INSTRUCTION_IM_ALLOWLIST）

- env `INSTRUCTION_IM_ALLOWLIST` 是逗号分隔的 sender id 白名单（如 `feishu:ou_a,slack:U_b`）。
  空值 = 全开（**仅 dev**；prod 必填）。
- 检查发生在 listener 顶层、`/` 前缀解析 _之后_：非匹配 sender 的普通聊天仍沉默；只有匹配
  到注册指令的非允许 sender 会收到 `[forbidden]` 回复。
- 与 `AuthService.resolveFromIm` 解耦：身份解析（→ userId）独立服务 socket / web；ACL 只
  是 IM 入口闸门。

## 卡片回复

| kind                          | 飞书卡片 builder                                                                             | Slack blocks builder                   |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| `instruction.reply`           | `buildInstructionReplyCard`                                                                  | `buildInstructionReplyBlocks`          |
| `instruction.async.started`   | `buildInstructionAsyncStartedCard`                                                           | `buildInstructionAsyncStartedBlocks`   |
| `instruction.async.completed` | `buildInstructionAsyncCompletedCard`                                                         | `buildInstructionAsyncCompletedBlocks` |
| `watch.hit`                   | `buildWatchHitCard`                                                                          | `buildWatchHitBlocks`                  |
| `agent.paid_confirm`          | `buildAgentPaidConfirmCard`（紫色 header；含 `/agent confirm=1 q="…"` 复制粘贴提示）         | — Slack 走纯文本兜底                   |
| `agent.tool_proposal`         | `buildAgentToolProposalCard`（紫色 header；含 `agent.confirm correlationId=… approve=1\|0`） | — Slack 走纯文本兜底                   |

- IM listener 在每条 `channels.send` 上挂 `meta = { ok, instructionId, code?, jobId?, durationMs? }`，由 adapter 端的 `pickCard` / `pickBlocks` 路由到对应 builder。
- 飞书 header 模板：sync 成功 `green`、失败 `red`；async started `orange`；async completed 与 sync 同色。
- Slack 始终同时塞 `text`（通知摘要 / 老客户端 fallback） + `blocks`（Block Kit 渲染）。
- 未知 kind 走原始文本路径（飞书 `stripSlackMrkdwn`，Slack 直接 mrkdwn）。

## 异步长任务通道

```
IM /analyze | /analyze.sector | /ta | /ta.sector | /ledger.analyze | /screen
                     │ ──► InstructionExecutor.dispatch
                     │     (mode === 'async')
                     ▼
               InstructionAsyncBus.enqueue ──► BullMQ "instruction.async"
                                                       │
                                                       ▼
                                          InstructionAsyncProcessor
                                              │   ├── SocketBus.emitTo(userId, 'instruction.async.started', …)
                                              │   └── EventEmitter2 'instruction.async.started'
                                              ▼
                                  executor.executeHandler (handler runs inline,
                                       bypassing async re-routing — see
                                       InstructionExecutor.executeHandler doc)
                                              │   ├── SocketBus.emitTo(userId, 'instruction.async.completed', …)
                                              │   └── EventEmitter2 'instruction.async.completed'
                                              ▼
                              IM listener.onAsyncCompleted ──► ChannelService.send (kind='instruction.async.completed')
```

- spec 加 `mode: 'async'` 即可走该通道；handler 不感知队列。
- `/agent` **不**走 BullMQ：它是 sync trigger handler（立即 ack）+ 后台 detached loop，
  循环过程通过 `instruction.agent.delta` socket topic 增量推帧（term 渲染流式输出，IM
  把 `step` / `tool_result` / `confirm` 帧再翻成 `agent.tool_proposal` 卡）。
- BullMQ `attempts=1`：长 LLM 操作自带超时/重试语义，避免重复付费 API 调用。
- socket topics（`packages/shared/src/types/socket.ts`）：`instruction.async.started` /
  `instruction.async.progress` / `instruction.async.completed`。`progress` 当前不被
  processor 自动 emit，留给后续 handler 主动上报中间帧。
- 进程重启会丢失未完成 job 的 IM 续推（`pendingByJobId` 是内存映射）。socket 客户端可订阅
  topic 自取，IM 端需要手动重发。

## 测试

- `packages/shared/src/instructions/parser.test.ts` —— parser / formatResult 单测。
- `apps/api/test/modules/instruction/parse-argv.spec.ts` —— argv tokenize / k=v / positional / quote。
- `apps/api/test/modules/instruction/instruction.registry.spec.ts` —— 注册 / alias / 重复 id / alias 冲突。
- `apps/api/test/modules/instruction/instruction.config.spec.ts` —— allowlist 空白容错 / debug 开关 boolean 解析。
- `apps/api/test/modules/instruction/instruction.executor.spec.ts` —— execute / executeLine / dispatch / mode='async' 入队 / zod 早失败 / 入队异常。
- `apps/api/test/modules/instruction/instruction.im.listener.spec.ts` —— `/` 前缀 / sync 回复 + meta / ACL forbidden / async started + 续推 completed。
- `apps/api/test/modules/instruction/instruction-async.processor.spec.ts` —— started/completed 事件链 / executor 抛错被包装成 completed 错误。
- `apps/api/test/modules/ledger/{ledger,ledger-analyze}.handler.spec.ts`、
  `apps/api/test/modules/blacklist/update.handler.spec.ts`、
  `apps/api/test/modules/screen/screen.handler.spec.ts` —— 业务 handler golden + 异常路径。
- `apps/api/test/modules/channel/{feishu-card,slack-card}.spec.ts` —— pickCard / pickBlocks 四类 kind + 截断 + 未知 kind fallback。

## 暂不做

- 流式中间 `instruction.async.progress` 心跳由 handler 主动 emit；processor 不自动产生
  进度帧。`/agent` 走独立的 `instruction.agent.delta` 通道，不复用这条。
- 飞书 / Slack interactive button → server callback（v1 用 paste-back 命令做软兜底；
  飞书 `card.action.trigger` 长连接钩子留待 v1.5）。
- LangGraph 编排：`/agent` 循环目前是 NestJS 直管的 while loop；多 agent 分支或长任务
  断点恢复才迁到 `services/py/quant_workflow/`（反向 RPC 调 NestJS `LlmService`）。
- 装饰器 + DiscoveryModule 扫描：handler 数 < 15 还不必要。
- 跨进程统一的 `InstructionSpec` 类型：等到出现第三个消费者（CLI / Electron）再抽（§2.5.2 Rule of Three）。
- 持久化 IM 续推映射：`pendingByJobId` 是内存 Map，进程重启会丢；socket 端可走 topic 自取。
