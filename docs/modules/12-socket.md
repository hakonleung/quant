# Socket — 实时通信总线

## 功能

- 统一的 FE↔BE 实时通信通道，**替换** 原 `/api/watch/stream`、`/api/orchestration/queue/stream` 两路 SSE。
- 双向：服务端推送（任务快照、队列快照、channel activity）+ 客户端命令（任意已注册的 `InstructionSpec`，参见 [`15-instructions.md`](./15-instructions.md)）。
- 单一 Socket.IO gateway，对应客户端 `socket.io-client` 单例；按 topic 分 Room，订阅者按 `subscribe` 入 room，只收订阅过的事件。

## 进程拓扑

```
Browser (Next dev :3000)
  │
  │  WebSocket  (cross-origin, same-host different-port allowed by CORS)
  ▼
NestJS API (:3001)
  ├─ SocketModule.forRoot({ commandHandler: SocketInstructionAdapter })
  │  ├─ SocketBus       # 其它 module 注入它发布事件
  │  ├─ SocketGateway   # @WebSocketGateway，订阅、命令、事件分发
  │  └─ corsOriginCallback
  ├─ WatchBroadcaster   # 1Hz emit('watch.snapshot', tasks)
  ├─ QueueBroadcaster   # 1Hz emit('queue.snapshot', snapshot)
  └─ ChannelBus         # emit('channel.activity', ...) 每条系统/手动/入站事件
```

## Topic 注册表

唯一来源：`packages/shared/src/types/socket.ts` 的 `SOCKET_TOPIC_SCHEMAS`。

| Topic                         | Payload                                                                                              | 来源                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `watch.snapshot`              | `WatchTask[]` (1Hz)                                                                                  | `WatchBroadcaster`                                              |
| `queue.snapshot`              | `QueueSnapshot` (1Hz)                                                                                | `QueueBroadcaster`                                              |
| `channel.activity`            | `ChannelActivity`（事件即推）                                                                        | `ChannelBus.publishActivity/Inbound`                            |
| `instruction.async.started`   | `InstructionAsyncStartedPayload`                                                                     | `InstructionAsyncProcessor`（emitTo userId）                    |
| `instruction.async.progress`  | `InstructionAsyncProgressPayload`                                                                    | handler 主动 emit（v1.5 暂未使用）                              |
| `instruction.async.completed` | `InstructionAsyncCompletedPayload`                                                                   | `InstructionAsyncProcessor`（emitTo userId）                    |
| `instruction.agent.delta`     | `InstructionAgentDeltaPayload`（5-kind union：`step` / `tool_result` / `confirm` / `text` / `done`） | `AgentService` 循环中 emitTo userId — 终端用来流式渲染 `/agent` |

新增 topic = 在 `SOCKET_TOPIC_SCHEMAS` 加一行，前端 `useSocketTopic('<topic>', schema)` 即可消费。
`instruction.async.*` 走 `emitTo(userId, …)`：socket 客户端只收到自己 userId 触发的 job 进度
（IM 触发的 job 同时由 listener 经 `ChannelService.send` 推回原 IM 频道，见 `docs/modules/15-instructions.md`）。

## 协议

```
client → server  subscribe   { topics: string[] }            ack: { ok, subscribed[] }
client → server  unsubscribe { topics: string[] }            ack: { ok, unsubscribed[] }
client → server  command     { id: '<instruction-id>', args: {...} }  ack: { ok, error?, detail? }
server → client  event       { topic, ts, payload }
```

命令分派经 `SocketInstructionAdapter` → `InstructionExecutor.execute(id, args, { source: 'socket' })`，与 IM 入站走同一注册表（`docs/modules/15-instructions.md`）。

CORS 通过 `apps/api/src/modules/socket/cors-origin.ts`：

- 允许 loopback hostnames（localhost / 127.0.0.1 / [::1]）所有端口。
- 允许 **same-host different-port**（请求 host 与 origin hostname 一致），无需写入白名单。
- `QUANT_ALLOWED_ORIGINS` 逗号分隔再加白名单（绝对 origin）。

## 前端

- `apps/web/lib/socket/socket-client.ts`：`io(...)` 单例。URL = `NEXT_PUBLIC_QUANT_SOCKET_URL` ?? `<window.protocol>//<window.hostname>:<NEXT_PUBLIC_QUANT_API_PORT ?? 3001>`。
- `apps/web/lib/socket/use-socket-topic.ts`：泛型 hook，封装 subscribe / unsubscribe / 解码。
- `apps/web/lib/socket/use-channel-activity.ts`：滚动 buffer + 折叠 pending → sent。

迁移完成的消费方：

| 旧 SSE                                  | 新 Socket topic  | 入口                                                           |
| --------------------------------------- | ---------------- | -------------------------------------------------------------- |
| `/api/watch/stream`                     | `watch.snapshot` | `feat-watch-live` 内 `useWatchStream`                          |
| `/api/orchestration/queue/stream`       | `queue.snapshot` | `apps/web/lib/hooks/use-queue-stream.ts`                       |
| `/api/watch/stream`（live-runner 一次） | （改为 GET）     | `apps/web/lib/term/live-runner.ts` 改用 `apiGet('/api/watch')` |

旧的 BFF SSE proxy（`apps/web/app/api/{watch,orchestration/queue}/stream/route.ts`）已删除。

## 测试

- `apps/api/test/modules/socket/cors-origin.spec.ts`：loopback / same-host / 白名单 / 拒绝。
- `apps/api/test/modules/socket/socket-bus.spec.ts`：合法 / 非法 payload / 无 sink。

## 安全

- v1 API 仍 `127.0.0.1` 监听，无鉴权；socket 同一进程，无额外鉴权层。
- 任何对外暴露的部署需要：① 改 host 监听 ② 接 OAuth/API Key ③ 收紧 `QUANT_ALLOWED_ORIGINS`。
