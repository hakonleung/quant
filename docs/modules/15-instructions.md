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

| 文件 | 内容 |
| ---- | ---- |
| `id.ts` | `InstructionId` 品牌类型 + `INSTRUCTION_ID_RE`（`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$`） + `instructionId(raw)` 校验 |
| `parser.ts` | `parseInstructionLine(text, knownIds, { requirePrefix? })`：剥离 `/` 前缀（IM 模式）→ 切首 token → 校验 id 是否在 `knownIds` 中。**不做** zod 校验、不做 argv tokenize。 |
| `result.ts` | `InstructionResult = { ok:true, output:{ text } } \| { ok:false, error:{ code, message } }`；`formatResult(r)` 用于 IM 文本 / FE toast 的统一渲染。 |
| `index.ts` | re-export 上述三个模块 |

**为什么共享层不放 spec 类型？** FE 的 `CommandSpec`（`@quant/terminal`）携带 tab 补全 + xterm 交互 widget；BE 的 `InstructionSpec` 用 zod argsSchema + Nest 注入的 service。两侧唯一可共享的是「id + summary + 参数 schema」，但 FE 现成 spec 没用 zod，强行统一会牵动 11 个命令文件，违反 §2.5.2 Rule of Three。

## BE 实例（`apps/api/src/modules/instruction/`）

| 文件 | 角色 |
| ---- | ---- |
| `instruction.spec.ts` | `InstructionSpec<TArgs> { id; summary; help?; argsSchema: z.ZodType<TArgs>; positional?; aliases? }` |
| `instruction.port.ts` | `InstructionHandler<TArgs> { execute(args, ctx): Promise<InstructionResult> }`；`InstructionCtx = { traceId; source: 'im' \| 'socket' \| 'http'; channelId?; sender?; target? }` |
| `instruction.registry.ts` | `@Injectable()`：`register(spec, handler)` / `get(id)` / `list()` / `knownIds()`；alias → canonical id |
| `instruction.executor.ts` | 两个入口：`execute(id, args, ctx)`（socket / http）和 `executeLine(line, ctx)`（IM）。zod 校验失败 → `{code:'validation'}`，handler 抛错 → `{code:'handler'}` |
| `instruction.provider.ts` | `InstructionRegistrarBase<TArgs>` —— 让 handler 类直接 extends，`onModuleInit` 自动注册 |
| `instruction.im.listener.ts` | `@OnEvent(CHANNEL_INBOUND_EVENT)` → 解析 → 执行 → `ChannelService.send` 回推 |
| `parse-argv.ts` | `tokenize(rest)` + `parseArgvToObject(rest, positional)`：把首 token 后的字符串切成 `Record<string,string>`，支持 `k=v`、位置参数、`"..."` 引号转义 |
| `socket-instruction.adapter.ts` | 实现 socket gateway 的 `SocketCommandHandler` 接口，把 `{id, args}` 路由到 executor |
| `instruction.module.ts` | `@Global()` 模块；导出 Registry / Executor / Adapter；导入 ChannelModule（IM listener 需要） |
| `handlers/{help,ping,channel-echo}.handler.ts` | 内置 handler |

### v1 已注册指令

| Spec id | 来源 | 摘要 |
| ------- | ---- | ---- |
| `help` | `instruction/handlers/help.handler.ts` | 列已注册 spec；`/help <id>` 显示详情 |
| `ping` | `instruction/handlers/ping.handler.ts` | echo args + traceId |
| `channel.echo` | `instruction/handlers/channel-echo.handler.ts` | 调试：原样回推 args + ctx |
| `channel.send` | `channel/instructions/channel-send.handler.ts` | socket / IM 共用的手动外发 |
| `focus` | `stock-meta/instructions/focus.handler.ts` | 校验 6 位 A 股 code 并回 `focus = <code> <name> (<industry>)` |
| `stock` | `stock-meta/instructions/stock.handler.ts` | 按 code / 名称 / 拼音搜索（默认 limit=10） |
| `sector` | `sectors/instructions/sector.handler.ts` | 列用户自定义板块 |
| `watch` | `watch/instructions/watch.handler.ts` | `watch list`（也接受别名 `watch.list`）—— 列 watch 任务 |

> v1 的 BE 不实现 `screen` / `analyze` / `ledger` / `update` / `cache` / `clear` 这些 term 命令——`cache`/`clear` 是 FE-only，其它需要更细致的 IM ergonomics 设计（参数面、长任务回推），延后到下个版本。`help` 输出只展示当前已注册的项。

### 文本语法

```
<id> [k=v ...] [positional ...]
```

- IM 端要求 `/` 前缀（避免普通聊天误触发）；term / socket 端不要前缀。
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

## 测试

- `packages/shared/src/instructions/parser.test.ts` —— parser / formatResult 单测。
- `apps/api/test/modules/instruction/parse-argv.spec.ts` —— argv tokenize / k=v / positional / quote。
- `apps/api/test/modules/instruction/instruction.registry.spec.ts` —— 注册 / alias / 重复 id / alias 冲突。
- `apps/api/test/modules/instruction/instruction.executor.spec.ts` —— execute / executeLine / 校验错 / handler 抛错。
- `apps/api/test/modules/instruction/instruction.im.listener.spec.ts` —— `/` 前缀过滤 / 命中回复 / 解析错回复 / 校验错回复。

## 暂不做

- 发件人白名单（ACL）：v1 没有；任何能进 `channel.inbound` 的人都能跑指令。生产部署前必须在 listener 顶层加 `INSTRUCTION_IM_ALLOWLIST` env 检查。
- Slack blocks / Feishu cards：v1 仅文本回复。
- 异步长任务回推：v1 同步阻塞返回；后续接 `screen.run` / `update` 等长任务时再加 `instruction.async.{started,progress,completed}` 流。
- 装饰器 + DiscoveryModule 扫描：handler 数 < 15 还不必要。
- 跨进程统一的 `InstructionSpec` 类型：等到出现第三个消费者（CLI / Electron）再抽（§2.5.2 Rule of Three）。
