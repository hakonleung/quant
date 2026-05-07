# Channel + Socket 迁移清单

> 本文记录 2026-05 这次将 SSE → Socket.IO、push → Channel 的总览改动；执行后用作 reviewer / runbook。

## 一、安装 / 配置 checklist

- [x] `apps/api` 安装 `@nestjs/platform-socket.io`、`@nestjs/websockets`（pin 至 ^10.4.15 与 NestJS 10 主版本匹配）。
- [x] `apps/api` 安装 `@nestjs/event-emitter`、`@nestjs/bullmq`、`bullmq`、`ioredis`。
- [x] `apps/api` 安装 IM SDK：`@slack/web-api`、`@slack/socket-mode`、`@larksuiteoapi/node-sdk`。
- [x] `apps/web` 安装 `socket.io-client`。
- [ ] 部署文档加 Redis 依赖（dev 直接 `redis-server`，prod 需要规划）。
- [ ] `.env` 模板加上 `CHANNEL_*` 段（参考 [11-channel.md §配置](./11-channel.md#配置appsapienv)）。

## 二、后端模块

### Socket 模块（新增）

- [x] `apps/api/src/modules/socket/cors-origin.ts`：loopback / same-host / 白名单。
- [x] `apps/api/src/modules/socket/socket-bus.service.ts`：emit + zod 校验 + sink。
- [x] `apps/api/src/modules/socket/socket.gateway.ts`：subscribe / unsubscribe / command + room 分发。
- [x] `apps/api/src/modules/socket/socket.module.ts`：`@Global()` + `forRoot({ commandHandler })`。
- [x] `apps/api/src/main.ts` 切到 `corsOriginCallback`（同时管 HTTP + socket）。

### Channel 模块（新增，替换 push）

- [x] `apps/api/src/modules/channel/config/channel.config.ts`：env zod 校验，缺 token 直接抛错。
- [x] `apps/api/src/modules/channel/ports/channel-adapter.port.ts`：抽象接口。
- [x] `apps/api/src/modules/channel/adapters/slack.adapter.ts`：Web API + Socket Mode。
- [x] `apps/api/src/modules/channel/adapters/feishu.adapter.ts`：Lark Client + WSClient。
- [x] `apps/api/src/modules/channel/channel.registry.ts`：生命周期 + inbound 路由。
- [x] `apps/api/src/modules/channel/bus/channel-bus.service.ts`：BullMQ + EventEmitter2 + SocketBus。
- [x] `apps/api/src/modules/channel/bus/outbound.processor.ts`：BullMQ Worker。
- [x] `apps/api/src/modules/channel/channel.service.ts`：`broadcast` / `send` 公共门面。
- [x] `apps/api/src/modules/channel/channel-command.service.ts`：实现 `SocketCommandHandler`。
- [x] `apps/api/src/modules/channel/channel.controller.ts`：`POST /api/channel/send` + `GET /api/channel/list`。
- [x] `apps/api/src/modules/channel/channel.module.ts`：`EventEmitterModule.forRoot` + `BullModule.forRootAsync` + `registerQueue`。

### 既有模块改造

- [x] `apps/api/src/modules/watch/`：删除 `watch-notifier.ts`，scheduler 注入 `ChannelService.broadcast(...)` 替代。
- [x] `apps/api/src/modules/watch/watch.controller.ts`：删除 `@Sse('stream')` handler。
- [x] `apps/api/src/modules/watch/watch.broadcaster.ts`：新增 `setInterval` → `SocketBus.emit('watch.snapshot', ...)`。
- [x] `apps/api/src/modules/orchestration/queue-status.controller.ts`：删除 `@Sse('queue/stream')` handler。
- [x] `apps/api/src/modules/orchestration/queue.broadcaster.ts`：新增；导出 `makeSnapshot()` 供 GET 复用。
- [x] `apps/api/src/modules/push/`：整目录删除。
- [x] `apps/api/src/app.module.ts`：去掉 `PushModule`，加 `ChannelModule` + `SocketModule.forRoot({ imports:[ChannelModule], commandHandler: ChannelCommandService })`。
- [x] `apps/api/test/modules/watch/watch.scheduler.spec.ts`：FakeNotifier 改成 fake `ChannelService`。

## 三、共享 schema

- [x] `packages/shared/src/types/channel.ts`：`ChannelId / ChannelActivity / ChannelOutboundRequest / ChannelStatus`。
- [x] `packages/shared/src/types/socket.ts`：`SocketEnvelope`、`SOCKET_TOPIC_SCHEMAS`、`SocketCommand` 等。
- [x] `packages/shared/src/types/index.ts`：re-export。
- [ ] **保留** `packages/shared/src/types/push.ts`（未删，旧导入若仍存在不会爆；后续清理可删）。

## 四、前端

- [x] `apps/web/lib/socket/socket-client.ts`：`io(...)` 单例。
- [x] `apps/web/lib/socket/use-socket-topic.ts`：泛型 hook。
- [x] `apps/web/lib/socket/use-channel-activity.ts`：滚动 buffer。
- [x] `apps/web/lib/hooks/use-queue-stream.ts`：迁到 `useSocketTopic('queue.snapshot', ...)`。
- [x] `apps/web/components/feat-watch-live/feat-watch-live.tsx`：`useWatchStream` 内部改 socket。
- [x] `apps/web/lib/term/live-runner.ts`：`watch.list` 改用 `apiGet('/api/watch')`，删除 `readWatchOnce` 的 SSE 一次性消费。
- [x] `apps/web/app/api/watch/route.ts`：新增 `GET` handler 把 NestJS 一次性列表转出来。
- [x] `apps/web/app/api/watch/stream/`、`apps/web/app/api/orchestration/queue/stream/`：BFF SSE proxy 整目录删除。
- [x] `apps/web/components/feat-channel/`：`feat-channel.tsx` + `activity-row.tsx` + `filter-chips.tsx`。
- [x] `apps/web/lib/eqty/feat.ts`：注册 `Feat.ChannelLive = 'CHN.LIVE'` + 配置。
- [x] `apps/web/components/shell/top-bar.tsx`：插槽里挂 `<FeatChannelLive />`。

## 五、测试

- [x] `apps/api/test/modules/socket/cors-origin.spec.ts` — 4 cases。
- [x] `apps/api/test/modules/socket/socket-bus.spec.ts` — 3 cases（合法 / 非法 / 无 sink）。
- [x] `apps/api/test/modules/channel/channel-config.spec.ts` — 6 cases。
- [x] `apps/api/test/modules/channel/channel.service.spec.ts` — 4 cases。
- [x] `apps/api/test/modules/channel/channel-command.service.spec.ts` — 4 cases。
- [x] `apps/api/test/modules/watch/watch.scheduler.spec.ts` — 既有 10 个 case 在 FakeNotifier → ChannelService 重写后全部通过。
- [ ] adapter 集成测试（mock `@slack/web-api` / lark Client）— 后续补，需要设计 SDK 调用面。
- [ ] BullMQ outbound processor 端到端（用 `ioredis-mock` 或本地 redis）— 后续补。

## 六、验证手册（end-to-end）

1. 启动 Redis：`redis-server &`。
2. `apps/api/.env`：`CHANNEL_ENABLED=`（先空，dry-run）；启 `pnpm dev:ts`。
3. 浏览器访问 `http://localhost:3000`，DevTools → Network → WS 应能看到一条 socket.io 长连。
4. `feat-watch-live` 1Hz 列表更新，`SYS.STAT` 队列动态正常。
5. 添加一个 always-true watch task → `feat-channel` 出现 `pending` 行，几十毫秒内变 `dryrun`（无凭据时）或 `sent`。
6. 配 `CHANNEL_ENABLED=slack`、`CHANNEL_SLACK_BOT_TOKEN=...`、`CHANNEL_SLACK_APP_TOKEN=...`，重启：`feat-channel` 行变 `sent`，Slack 频道收到消息；@mention bot 后 `feat-channel` 出现 `inbound` 行。
7. 跨域：浏览器开 `http://127.0.0.1:3000`（hostname 不同）—— 仍能连上（loopback）；伪造一个 `http://192.168.x.y:3000` 访问 `127.0.0.1:3001`（同主机不同 hostname）—— `CORS` 拒。可设置 `QUANT_ALLOWED_ORIGINS` 单独放行。

## 七、未做 / TODO

- [ ] 前端 `feat-channel` 写入 UI（socket `command.channel.send`）。
- [ ] adapter 失败重连策略：当前依赖 SDK 内置；正式部署前需要看监控。
- [ ] Python 兜底 notify 路径（`quant_core.NotificationService`）的并入；当前仍并行存在。
- [ ] `packages/shared/src/types/push.ts` 等死后清理（无新引用即可删）。
