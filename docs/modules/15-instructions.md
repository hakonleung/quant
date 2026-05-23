# Instructions — 跨进程指令集

## 功能

- 将「FE term 命令 / IM 入站消息 / Socket 命令」三条路径统一到一套
  `InstructionCenter<E, X>` 下（`packages/shared/src/instructions/center.ts`）。
- **Manifest**（`packages/shared/src/instructions/manifest.ts`）是唯一的声明源：
  args schema、result schema、别名、mode、revalidate scopes、doubleConfirm、
  imGate、positional 绑定全部在此声明一次。
- **FE 单例** `feCenter`（`apps/web/lib/instructions/fe-center.ts`）承载所有
  FE 指令；**BE 单例** `BeInstructionCenter`
  （`apps/api/src/modules/instruction-center/be-instruction-center.service.ts`）
  承载所有 BE 指令。两侧均由 `InstructionCenter<Env, Excluded>` 实例化，
  `Excluded` 联合列出本侧不参与的 id。
- BE 端订阅 `channel.inbound`（Slack / Feishu）：匹配指令 → 执行 → 通过
  `ChannelService.send` 把结果回推到同一频道，构成 IM 闭环。
- Socket 命令 `{ id, args }` 统一走 `InstructionExecutor`，不再为每条命令
  单独写 schema 分支。

## 进程拓扑

```
                packages/shared/src/instructions/
                ┌──────────────────────────────────────────────────────┐
                │  InstructionCenter<E, X>   (center.ts)               │
                │  INSTRUCTION_MANIFEST      (manifest.ts)             │  ← 跨进程唯一源
                │  ArgsOf<I> / ResultOf<I>   (center.ts)               │
                │  InstructionId / parse     (id.ts / parse.ts)        │
                │  InstructionResult         (result.ts)               │
                └──────────────────────────────────────────────────────┘
                        ▲                              ▲
        ┌───────────────┘                              └──────────────────────┐
        │                                                                     │
   FE 单例                                                              BE 单例
   apps/web/lib/instructions/fe-center.ts                apps/api/src/modules/instruction-center/
   ──────────────────────────────────────                ──────────────────────────────────────────
   feCenter = InstructionCenter<FeEnv, Excluded>         BeInstructionCenter
   cells/* — FE 侧 handler + renderer                    cells/* — BE 侧 handler + renderer
   dispatch.ts — feDispatch() 接收 runCommand 效果        be-types.ts — BeEnv / BeCtx / ImHost
   completion.ts — buildCompleterEnv(stockIndex)
   feat-term-main 唯一入口；⌘K → setAppMode('term')

   InstructionRegistry（apps/api/src/modules/instruction/）
   ─────────────────────────────────────────────────────────────────
   仅承载 help / ping / channel.echo / channel.send 四条 IM-only / debug 门控指令
   InstructionImListener  ← @OnEvent('channel.inbound')
   SocketInstructionAdapter ← SocketCommandHandler
```

## 共享层（`packages/shared/src/instructions/`）

| 文件          | 内容                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `center.ts`   | `InstructionCenter<E, X>`：统一 dispatcher；`InstructionCell`、`InstructionConfig`、`InstructionEnv`、`coerceArgs`、`AllInstructionIds`、`ArgsOf<I>`、`ResultOf<I>` 等类型 |
| `manifest.ts` | `INSTRUCTION_MANIFEST`：每条指令的 `argsSchema`、`resultSchema`、`aliases`、`positional`、`mode`、`requiresImConfirm`、`revalidate` 等声明；`COMMAND_MANIFEST` 扁平数组     |
| `schemas.ts`  | 所有 `XxxArgsSchema` / `XxxResultSchema`（zod）；manifest 引用这里；两侧 handler 通过 `ArgsOf<I>` 取类型                                                                  |
| `id.ts`       | `InstructionId` 品牌类型 + `INSTRUCTION_ID_RE` + `instructionId(raw)` 校验                                                                                                |
| `parse.ts`    | `tokenize` / `parseArgv`：把字符串切成 `{ positional, flags }` 供 `InstructionCenter.dispatch` 内部使用                                                                   |
| `parser.ts`   | `parseInstructionLine(text, knownIds, { requirePrefix? })`：IM 路径用（剥 `/` 前缀 → 匹配 knownIds）                                                                      |
| `result.ts`   | `InstructionResult`；`InstructionError` + `InstructionErrorCode`；`formatResult(r)`                                                                                       |
| `index.ts`    | re-export 上述所有模块                                                                                                                                                     |

## BE 实例

### `instruction-center/`（主路径）

`apps/api/src/modules/instruction-center/` 承载所有 manifest 指令。

| 文件                                   | 角色                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `be-instruction-center.service.ts`     | `@Injectable()` NestJS service；`BeInstructionCenter = InstructionCenter<BeEnv, Excluded>`；`has(id)` + `executeMigrated(id, args, ctx)` 供 executor 调用  |
| `be-types.ts`                          | `BeEnv`、`BeCtx`（NestJS services 注入包）、`ImHost`、`ImOutput`                                                                                           |
| `cells/`                               | 每条 BE 指令一个 `*.cell.ts`：`handler` + `renderer`（可选 `peek`）                                                                                        |
| `instruction-center.module.ts`         | 装配 `BeInstructionCenter` 及其 cell 所需 services                                                                                                         |
| `async/`                               | BullMQ `instruction.async` 队列 + processor（与 `InstructionExecutor` 共用）                                                                              |
| `handlers/{help,ping,channel-echo}.handler.ts` | IM-only / debug 门控 handlers，不在 manifest                                                                                                       |

### `instruction/`（IM-only / debug 入口）

| 文件                            | 角色                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instruction.types.ts`          | `InstructionSpec<TArgs>` + `AnyInstructionSpec`                                                                                                                                   |
| `instruction.port.ts`           | `InstructionHandler<TArgs>`；`InstructionCtx = { traceId; source; channelId?; sender?; target? }`                                                                                |
| `instruction.registry.ts`       | `@Injectable()`：`register` / `get` / `list` / `knownIds`；只剩 `help` / `ping` / `channel.echo` / `channel.send` 四条注册项                                                    |
| `instruction.executor.ts`       | `execute(id, args, ctx)` + `executeLine(line, ctx)`；先检查 `BeInstructionCenter.has(id)` 拦截，否则回落 `InstructionRegistry`                                                   |
| `instruction.provider.ts`       | `InstructionRegistrarBase<TArgs>` — `onModuleInit` 自动调 `registry.register`；作用域限于上述四条 handler                                                                        |
| `instruction.im.listener.ts`    | `@OnEvent(CHANNEL_INBOUND_EVENT)` → 解析 → executor → `ChannelService.send` 回推                                                                                                 |
| `parse-argv.ts`                 | `tokenize(rest)` + `parseArgvToObject`：本路径用；manifest 路径改用 `packages/shared/src/instructions/parse.ts`                                                                  |
| `socket-instruction.adapter.ts` | 把 `{id, args}` 路由到 executor                                                                                                                                                   |
| `instruction.module.ts`         | `@Global()`；注入 `INSTRUCTION_CONFIG`、BullMQ 队列；导出 Registry / Executor / AsyncBus / Adapter                                                                               |
| `instruction.config.ts`         | `INSTRUCTION_IM_ALLOWLIST` + `INSTRUCTION_DEBUG_ENABLED`                                                                                                                          |

### Manifest 指令（`BeInstructionCenter` + `feCenter` 共享）

下表中 `help` 在 FE 侧有 cell（`cells/help.cell.ts`），BE 侧另由 `instruction/handlers/help.handler.ts` 直接对接 IM。
其余指令两侧均通过 manifest 统一定义。

| Spec id            | FE cell 来源                                       | BE cell 来源（`instruction-center/cells/`）        | 模式      | 摘要                                                                                                                                              |
| ------------------ | -------------------------------------------------- | -------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `help`             | `cells/help.cell.ts`                               | —（registry-only）                                 | sync      | FE：列 manifest 指令；IM：通过 `help.handler.ts` 列 registry 已注册 spec                                                                         |
| `focus`            | `cells/focus.cell.ts`                              | `focus.cell.ts`                                    | sync      | 校验 6 位 A 股 code 并回 `focus = <code> <name> (<industry>)`                                                                                     |
| `stock`            | `cells/stock.cell.ts`        | `cells/stock.cell.ts`         | sync      | 按 code / 名称 / 拼音搜索（默认 limit=10）                                                                                                        |
| `stock.info`       | `cells/stock-info.cell.ts`   | `cells/stock-info.cell.ts`    | sync      | 单股详情                                                                                                                                          |
| `stock.kline`      | `cells/stock-kline.cell.ts`  | `cells/stock-kline.cell.ts`   | sync      | 单股 K 线                                                                                                                                         |
| `sector`           | `cells/sector.cell.ts`       | `cells/sector.cell.ts`        | sync      | 列对当前用户可见的板块（own + published），输出包含 OWNER 与 [PUB] 标识                                                                           |
| `sector.show`      | `cells/sector-show.cell.ts`  | `cells/sector-show.cell.ts`   | sync      | 板块详情 + 成员列表                                                                                                                               |
| `sector.add`       | `cells/sector-add.cell.ts`   | `cells/sector-add.cell.ts`    | sync      | `sector.add sector=<json>`；无引导式多步表单                                                                                                      |
| `sector.publish`   | `cells/sector-ack.cell.ts`   | `cells/sector-publish.cell.ts` | sync    | `sector.publish <id>` 仅创建者；置 `published=true`                                                                                               |
| `sector.unpublish` | `cells/sector-ack.cell.ts`   | `cells/sector-publish.cell.ts` | sync    | `sector.unpublish <id>` 仅创建者；恢复私有                                                                                                        |
| `sector.refresh`   | `cells/sector-refresh.cell.ts` | `cells/sector-refresh.cell.ts` | sync  | 任何用户可触发；动态板块按 `screenPlan` 重跑并落库，所有人共享结果                                                                               |
| `sector.rm`        | `cells/sector-ack.cell.ts`   | `cells/sector-rm.cell.ts`     | sync      | owner-only 删除                                                                                                                                    |
| `watch`            | `cells/watch.cell.ts`        | `cells/watch.cell.ts`         | sync      | 列 watch 任务（别名 `watch.list`）                                                                                                                 |
| `watch.add`        | `cells/watch-add.cell.ts`    | `cells/watch-add.cell.ts`     | sync      | `watch.add code=... market=... group=...`；无引导式表单                                                                                           |
| `watch.remove`     | `cells/watch-remove.cell.ts` | `cells/watch-remove.cell.ts`  | sync      | `watch.remove id=wN`                                                                                                                              |
| `watch.group`      | `cells/watch-group.cell.ts`  | `cells/watch-group.cell.ts`   | sync      | watch 分组管理                                                                                                                                     |
| `ledger`           | `cells/ledger.cell.ts`       | `cells/ledger.cell.ts`        | sync      | `/ledger [limit=N]`：基于 `LedgerService.enriched` 输出近 N 条                                                                                    |
| `ledger.add`       | `cells/ledger-add.cell.ts`   | `cells/ledger-add.cell.ts`    | sync      | 添加持仓记录                                                                                                                                       |
| `ledger.remove`    | `cells/ledger-remove.cell.ts`| `cells/ledger-remove.cell.ts` | sync      | 删除持仓记录                                                                                                                                       |
| `ledger.analyze`   | `cells/ledger-analyze.cell.ts` | `cells/ledger-analyze.cell.ts` | **async** | `/ledger.analyze [fresh=1]` `[$]`：调 `LedgerService.analyze`（LLM），走 `instruction.async` 通道                                              |
| `analyze`          | `cells/analyze.cell.ts`      | `cells/analyze.cell.ts`       | **async** | `/analyze <code> [fresh=1] [windowDays=N]` `[$]`：单只新闻舆情；async 通道                                                                        |
| `analyze.sector`   | `cells/analyze-sector.cell.ts` | —（BE-excluded）              | **async** | `/analyze.sector <id> [fresh=1]` `[$]`：板块成员舆情扇出 + LLM 主题聚类；FE async 通道のみ                                                      |
| `ta`               | `cells/ta.cell.ts`           | `cells/ta.cell.ts`            | **async** | `/ta <code> [fresh=1]` `[$]`：单只技术分析；async 通道                                                                                            |
| `ta.sector`        | `cells/ta-sector.cell.ts`    | `cells/ta-sector.cell.ts`     | **async** | `/ta.sector <id> [fresh=1]` `[$]`：板块成员 TA 扇出 + LLM 综述；async 通道                                                                       |
| `screen`           | `cells/screen.cell.ts`       | `cells/screen.cell.ts`        | **async** | `/screen "<NL>" [asof=YYYY-MM-DD]` `[$]`：NL→DSL + `ScreenExecService`（无 Flight）；async 通道                                                   |
| `agent`            | `cells/agent.cell.ts`        | `cells/agent.cell.ts`         | sync      | `/agent <prompt>` `[$]`：多步 tool-use；`confirm-required` 让 IM 出付费卡 / term 出 confirmPrompt                                                  |
| `agent.confirm`    | `cells/agent-confirm.cell.ts`| `cells/agent-confirm.cell.ts` | sync      | `/agent.confirm correlationId=… approve=1\|0`：续派被暂停的循环                                                                                   |
| `usr`              | `cells/usr.cell.ts`          | `cells/usr.cell.ts`           | sync      | 用户身份 + LLM ledger 累计（今日 / 本月 / 总计 + per-scope CNY）                                                                                  |
| `update`           | `cells/update.cell.ts`       | `cells/update.cell.ts`        | sync      | `/update target=blacklist` `[!]`：调 `BlacklistService.refresh`                                                                                   |
| `cache`            | `cells/cache.cell.ts`        | —（BE-excluded）              | sync      | FE-only：action runner 缓存 stats / clear                                                                                                         |
| `clear`            | `cells/clear.cell.ts`        | —（BE-excluded）              | sync      | FE-only：清空 term 滚动缓存                                                                                                                        |
| `web.search`       | —（FE-excluded）             | `cells/web-search.cell.ts`    | sync      | BE-only（`/agent` 工具集）：Qwen 付费网搜，输出中文摘要                                                                                           |

#### Registry 专属指令（不在 manifest 里）

以下四条仍通过 `InstructionRegistry` / `InstructionRegistrarBase` 注册，
不在 `INSTRUCTION_MANIFEST` 中，因此也不在 `feCenter`。

| Spec id        | 来源                                           | 门控                          | 用途                                                   |
| -------------- | ---------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `help`         | `instruction/handlers/help.handler.ts`         | 始终注册                      | 列 registry 中已注册 spec（IM 专用）                   |
| `ping`         | `instruction/handlers/ping.handler.ts`         | `INSTRUCTION_DEBUG_ENABLED=1` | echo args + traceId — 链路存活探针                     |
| `channel.echo` | `instruction/handlers/channel-echo.handler.ts` | `INSTRUCTION_DEBUG_ENABLED=1` | 原样回推 args + ctx — 调 IM 鉴权 / 路由时用            |
| `channel.send` | `channel/instructions/channel-send.handler.ts` | `INSTRUCTION_DEBUG_ENABLED=1` | 手动外发（socket / web term 触发）；prod IM 通常不需要 |

### 文本语法

```
<id> [k=v ...] [positional ...]
```

- IM 端要求 `/` 前缀（避免普通聊天误触发）；term / socket 端不要前缀。
- **IM 兜底**：allowlist 内的 sender 发的裸消息（无 `/`，且不匹配任何已注册 id / 别名）会被自动路由到 `/agent q="<原文>"`；非 allowlist 仍沉默。
- **manifest 元数据**：`doubleConfirm: 'llm'`（外部付费 LLM）渲染为 `[$]`；
  `doubleConfirm: 'destructive'`（不可逆写）渲染为 `[!]`；`imGate: true` 表示
  IM 端在分发前必须等待用户确认卡片。`/agent` 循环按这些 flag 决定是否在工具调用前暂停。
- **`InstructionError.code`** 包含 `confirm-required`：handler 抛出时表示需要付费确认；
  IM listener 把它映射成 `agent.paid_confirm` 卡 kind 而不是红色 error。
- `k=v` 对应 spec 的 zod 字段；位置参数按 `spec.positional` 顺序填入对应 key（已被 `k=v` 占用的 key 跳过）。
- 双引号包裹的值支持 `\"` 与 `\\` 转义；超过 `positional` 数量的多余位置参数静默丢弃，由 `argsSchema` 决定是否报错。

例：

- `/focus 600519` → `{ code: '600519' }`
- `/stock q=平安 limit=5` → `{ q: '平安', limit: 5 }`
- `/channel.send slack "hello world"` → `{ channel: 'slack', text: 'hello world' }`

## FE 实例

- **`feCenter`**（`apps/web/lib/instructions/fe-center.ts`）是进程单例，类型为
  `InstructionCenter<FeEnv, Excluded>`，包含所有 FE 指令的 `handler` + `renderer`。
- `apps/web/lib/instructions/dispatch.ts` 的 `feDispatch(line, ctx)` 接收 engine
  `runCommand` 效果，调用 `feCenter.dispatch(...)` 并在成功后扇出 manifest 声明的
  `revalidate` scopes。
- `apps/web/lib/instructions/completion.ts` 的 `buildCompleterEnv(stockIndex)` 从
  `INSTRUCTION_MANIFEST` 派生 tab 补全的 `commands` / `subcommands` / `paramCompleter`，
  不再依赖 `CommandRegistry`。
- `packages/terminal/src/registry.ts` 现在只导出 `CommandCtx`、`CommandRunOutput`、
  `CommandStores`、`UiStoreShim`、`RevalidateScope`、`CommitResolution` 等 ctx / 输出类型。
  `CommandSpec`、`CommandRegistry`、`createRegistry`、`createDefaultRegistry`、
  `CommandError` 均已删除。
- `apps/web/components/feat-cmd-palette/` 已**删除**。⌘K 全局快捷键直接
  `setAppMode('term')`（参见 `apps/web/components/shell/app-shell.tsx`），
  顶栏 `TermTrigger` 替代旧的 palette chip。

## Socket 路径

- 共享 schema：`packages/shared/src/types/socket.ts` 的 `SocketCommandSchema = { id, args }`。
- gateway：`apps/api/src/modules/socket/socket.gateway.ts` 仍用 `SOCKET_COMMAND_HANDLER` 注入，`AppModule` 把 `SocketInstructionAdapter` 通过 `SocketModule.forRoot` 接进去。
- 加新 manifest 指令：在 `packages/shared/src/instructions/manifest.ts` 注册 id + `argsSchema` + `resultSchema`，BE 写一个 `Cell` 实现并在 feature module 的 `providers` 列出；不需要改 schema / gateway / adapter。

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
- `packages/shared/src/instructions/center.test.ts` —— `InstructionCenter` dispatch / coerceArgs / alias / error envelopes。
- `packages/shared/src/instructions/manifest.test.ts` —— manifest id 唯一性 / schema 类型一致性。
- `apps/api/test/modules/instruction/parse-argv.spec.ts` —— argv tokenize / k=v / positional / quote。
- `apps/api/test/modules/instruction/instruction.registry.spec.ts` —— registry：注册 / alias / 重复 id / alias 冲突。
- `apps/api/test/modules/instruction/instruction.config.spec.ts` —— allowlist 空白容错 / debug 开关 boolean 解析。
- `apps/api/test/modules/instruction/instruction.executor.spec.ts` —— execute / executeLine / dispatch / mode='async' 入队 / BeInstructionCenter 拦截。
- `apps/api/test/modules/instruction/instruction.im.listener.spec.ts` —— `/` 前缀 / sync 回复 + meta / ACL forbidden / async started + 续推 completed。
- `apps/api/test/modules/instruction/instruction-async.processor.spec.ts` —— started/completed 事件链 / executor 抛错被包装成 completed 错误。
- `apps/api/test/modules/channel/{feishu-card,slack-card}.spec.ts` —— pickCard / pickBlocks 四类 kind + 截断 + 未知 kind fallback。

## 暂不做

- 流式中间 `instruction.async.progress` 心跳由 handler 主动 emit；processor 不自动产生
  进度帧。`/agent` 走独立的 `instruction.agent.delta` 通道，不复用这条。
- 飞书 / Slack interactive button → server callback（v1 用 paste-back 命令做软兜底；
  飞书 `card.action.trigger` 长连接钩子留待 v1.5）。
- LangGraph 编排：`/agent` 循环目前是 NestJS 直管的 while loop；多 agent 分支或长任务
  断点恢复才迁到 `services/py/quant_workflow/`（反向 RPC 调 NestJS `LlmService`）。
- 流式中间帧心跳：`instruction.async.progress` 由 handler 主动 emit；processor 不自动产生。
- 持久化 IM 续推映射：`pendingByJobId` 是内存 Map，进程重启会丢；socket 端可走 topic 自取。
- 多步引导式表单（`sector.add` name→kind→codes，`watch.add` 多条件）可作为返回
  `confirm-required` 风格 follow-up 行的 cell renderer 实现，无需框架改动。
