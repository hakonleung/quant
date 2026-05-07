# Channel + Socket 迁移 — Review Checklist

> 这一份是给人工 reviewer 用的，按顺序勾。每个条目附了应当看到的现象 / 命令 / 关键文件路径，方便快速判断是否通过。
> 如果某项不通过：在条目末尾追加 `❌ 原因 + 截图/日志` 即可，不用回退到本文上。

---

## 0. 准备

- [ ] `git status` 干净，所有改动已合入对应分支。
- [ ] `redis-server` 运行（`brew services start redis` 或 `redis-server &`）。
- [ ] `apps/api/.env` 至少有：
  - [ ] `CHANNEL_REDIS_URL=redis://127.0.0.1:6379`（默认就是这个，可省）
  - [ ] `CHANNEL_DRY_RUN=true`（首次跑用 dry-run 验证链路，不打扰真实工作群）

---

## 1. 编译 / 类型 / Lint

- [ ] `pnpm --filter @quant/api typecheck` 通过。
- [ ] `pnpm --filter @quant/shared typecheck` 通过。
- [ ] `pnpm --filter @quant/web typecheck` 仅遗留 `lib/term/revalidate.ts(24)` 的旧问题，**没有新增**。
- [ ] `pnpm format:check` 通过。
- [ ] `pnpm lint` 通过。

## 2. 单元测试

- [ ] `pnpm --filter @quant/api jest --testPathPattern="(socket|channel|watch.scheduler)"` 全绿（22 + 10 = 32 cases）。
- [ ] `pnpm --filter @quant/api jest` 整体除 `market-hours.spec.ts:66` 这条 pre-existing 红外，其它全绿。

## 3. 后端代码评审要点

### 3.1 跨域 / CORS

- [ ] `apps/api/src/modules/socket/cors-origin.ts`：loopback / same-host different-port / `QUANT_ALLOWED_ORIGINS` 三层。
- [ ] `apps/api/src/main.ts` 已改用 `corsOriginCallback`，旧的 `[/^http:\/\/localhost.../]` 正则已删除。
- [ ] gateway `@WebSocketGateway({ cors: { origin: corsOriginCallback, credentials: true } })`。

### 3.2 Socket 模块

- [ ] `SocketBus.emit` 严格 zod 校验（`SOCKET_TOPIC_SCHEMAS`）。校验失败只 warn 不抛，避免拖死 broadcaster。
- [ ] gateway 实现 `SocketSink`，`onModuleInit` 把自己注册回 bus（避免循环依赖）。
- [ ] `SocketModule.forRoot({ commandHandler })` 仅在 app composition root 调用一次。
- [ ] 命令分发：`SocketCommandHandler` 是 port，唯一实现是 `ChannelCommandService`，注册时用 `useExisting` —— 没有重复 instance。

### 3.3 Channel 模块（结构）

- [ ] 分层符合 §2.4：`controller → service → registry/bus → adapter`。`domain/types.ts`（schema）是核心资产，**不**依赖框架。
- [ ] adapter 各自封装 SDK 细节（`@slack/web-api`、`@larksuiteoapi/node-sdk`），对外只暴露 `send / subscribe / start / stop`。
- [ ] `ChannelRegistry` 统一管 `start()` / `stop()`、把 inbound 事件路由到 `ChannelBus.publishInbound`。
- [ ] `ChannelService.broadcast`：optimistic `pending` activity → 入队 outbound → worker 写终态 activity（按 `id` 折叠）。
- [ ] `ChannelOutboundProcessor`：异常时仍发一行 `failed` activity 让前端可见，再 `throw` 让 BullMQ 重试。
- [ ] 配置加载（`loadChannelConfig`）：启用某 IM 但缺凭据 → fail-fast 抛错。
- [ ] `EventEmitterModule.forRoot` 与 `BullModule.forRootAsync` / `registerQueue` 都在 `ChannelModule` 里声明，不污染 app.module。

### 3.4 Watch / Orchestration 改造

- [ ] `apps/api/src/modules/push/` 整目录已删除。
- [ ] `apps/api/src/modules/watch/watch-notifier.ts` 已删除。
- [ ] `watch.scheduler.ts` 改注入 `ChannelService`，调用 `broadcast({ kind: 'watch.hit', ... }, { source: 'system', traceId })`。
- [ ] `watch.controller.ts` 已删 `@Sse('stream')` handler；`queue-status.controller.ts` 已删 `@Sse('queue/stream')`。
- [ ] `WatchBroadcaster` / `QueueBroadcaster` 都 `OnModuleInit + setInterval(1000)`、`OnModuleDestroy` 清理 timer。
- [ ] 没有遗留的 `import.*Sse|from '@nestjs/common'.*Sse` —— `grep -rn '@Sse\b' apps/api/src` 应该完全空。

## 4. 前端代码评审要点

- [ ] `apps/web/lib/socket/socket-client.ts` 是 `io(...)` 单例；URL 解析考虑了 SSR（`typeof window === 'undefined'`）。
- [ ] `useSocketTopic` 泛型签名 `<S extends z.ZodTypeAny>(topic, schema): SocketStreamState<z.infer<S>>` —— 不是写死 `z.ZodType<T>`（避免 input/output type 不一致）。
- [ ] `useChannelActivity` 用 `baseId(...)` 折叠 pending → done/err；buffer 上限 500（默认）。
- [ ] `feat-channel` 用 `@tanstack/react-virtual` 渲染（CLAUDE.md memory: lists must be virtualized）。
- [ ] `feat-watch-live.tsx` 不再 `new EventSource`；`useWatchStream` 内部走 `useSocketTopic`。
- [ ] `lib/hooks/use-queue-stream.ts` 内部走 `useSocketTopic`，**对外形状不变**（status / snapshot 三态）。
- [ ] `lib/term/live-runner.ts` 中 `watch.list` 改用 `apiGet('/api/watch')`；`readWatchOnce` 整函数已删除。
- [ ] `apps/web/app/api/watch/route.ts` 加了 `GET` handler；`stream/` 子目录已删。
- [ ] `apps/web/app/api/orchestration/queue/stream/` 已删。
- [ ] `Feat.ChannelLive = 'CHN.LIVE'` + `FEAT_CONFIG_MAP` 配置存在；`top-bar.tsx` 挂载 `<FeatChannelLive />`。
- [ ] 全仓 `grep -rn "EventSource" apps/web` 应该没有任何结果。

## 5. 端到端 smoke

启动：`pnpm dev:ts`（ts-only 即可），浏览器开 `http://localhost:3000`。

- [ ] DevTools → Network → WS：能看到一条 `socket.io/?EIO=4` 长连，状态 101。
- [ ] `feat-watch-live` 打开后 1Hz 列表更新（每秒 ts 都在变）。
- [ ] `SYS.STAT` capsule 队列 / scan 状态 1Hz 跳动。
- [ ] 添加一个 always-true watch 任务（pct prev_close ≥ 0）→ `feat-channel` 立即出现 `pending` 行；DRY_RUN 下变 `dryrun`，否则变 `sent`。
- [ ] DRY_RUN 关掉、配上真实 Slack 凭据：
  - [ ] `feat-channel` 行变 `sent`；Slack 频道收到消息。
  - [ ] 在 Slack 里 @ bot，`feat-channel` 出现 `inbound` 行；服务器日志看到 `channel_inbound channel=slack sender=slack:U...`。
- [ ] Feishu 同上验证（如启用）。
- [ ] 手动 `curl -X POST http://127.0.0.1:3001/api/channel/send -H 'content-type: application/json' -d '{"text":"hello","kind":"manual"}'` → 200，`feat-channel` 多两行（pending + sent/dryrun）。

## 6. 跨域验证

- [ ] 浏览器开 `http://localhost:3000`，连 `127.0.0.1:3001`：通（loopback 白名单）。
- [ ] 浏览器开 `http://127.0.0.1:3000`，连 `127.0.0.1:3001`：通（同主机不同端口）。
- [ ] 浏览器开 `http://192.168.x.y:3000`（其它 hostname），连 `127.0.0.1:3001`：拒（除非 `QUANT_ALLOWED_ORIGINS` 放行）。
- [ ] 加 `QUANT_ALLOWED_ORIGINS=http://192.168.x.y:3000` 重启 → 通。

## 7. 错误路径

- [ ] 把 Redis 关掉再启动 API：BullMQ 会持续 ECONNREFUSED warn，但服务本身不崩；恢复 Redis 后队列自动重连。
- [ ] `CHANNEL_ENABLED=slack` 但不给 `CHANNEL_SLACK_BOT_TOKEN` → 启动直接抛 `channel:slack enabled but CHANNEL_SLACK_BOT_TOKEN is missing`。
- [ ] socket 客户端发非法 `subscribe { topics: [] }` → ack `{ ok: false, error: 'invalid_subscribe_payload' }`；不会 crash gateway。
- [ ] 给 `command` 发 `{ kind: 'channel.send', channel: 'unknown', text: '...' }` → zod 拒，ack `invalid_command_payload`。

## 8. 文档

- [ ] [`docs/modules/11-channel.md`](./11-channel.md) 描述实际匹配代码。
- [ ] [`docs/modules/12-socket.md`](./12-socket.md) 的 topic 表与 `SOCKET_TOPIC_SCHEMAS` 一致。
- [ ] [`docs/modules/09-notifications.md`](./09-notifications.md) 已重写，旧 → 新映射准确。
- [ ] [`docs/modules/13-channel-socket-migration.md`](./13-channel-socket-migration.md) checklist 与实际 commit 一致；勾掉的项确实落地。
- [ ] `docs/architecture.md` 拓扑图含 Socket.IO 与 Redis。
- [ ] `docs/modules/06-watch.md` 已不再提 `slack-webhook-notifier` / SSE。

## 9. 整体 verdict

- [ ] APPROVE / REQUEST_CHANGES（写在最后；不通过的请把所有 ❌ 项及修复建议汇总到 PR 评论）。
