# Notifications — 通知投递（已并入 Channel 模块）

> ⚠️ 历史文档：v1 的 NestJS 单 Slack-webhook 实现 (`SlackWebhookWatchNotifier`) 与 SYS.PUSH 模块已被新 Channel 模块替代。
> 详情见 [`docs/modules/11-channel.md`](./11-channel.md) 与 [`docs/modules/12-socket.md`](./12-socket.md)。

## 现状

- watch hit、cron 失败等系统事件 → `ChannelService.broadcast(...)` →（BullMQ 队列） → 各 IM。
- IM 入站（mention / DM）→ `ChannelBus.publishInbound` → 业务 module 通过 `@OnEvent('channel.inbound:<id>')` 订阅 + 前端 `feat-channel` 渲染。
- 每条事件同步推到 Socket.IO `channel.activity` topic，前端实时呈现。

## 旧 → 新映射

| 旧                                                                | 新                                                |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `apps/api/src/modules/push/`                                      | *（删除）*                                        |
| `apps/api/src/modules/watch/watch-notifier.ts`                    | *（删除）*                                        |
| `WatchNotifier` 接口                                              | `ChannelAdapter`（多 IM）                         |
| `SlackWebhookWatchNotifier`                                       | `apps/api/src/modules/channel/adapters/slack.adapter.ts`（Web API + Socket Mode） |
| `POST /api/push/test`                                             | `POST /api/channel/send`                          |
| `QUANT_WATCH_SLACK_WEBHOOK` / `SLACK_WEBHOOK_URL`                 | `CHANNEL_SLACK_BOT_TOKEN` 等（见 11-channel.md）  |

## 消息格式

watch hit 触发的渲染逻辑保留在 `apps/api/src/modules/watch/domain/format.ts`（mrkdwn 三行）。新 channel 模块直接消费 `format.buildPayload(...)` 的 `text` 字段，未来支持卡片/Block Kit 时再扩展 `OutboundMessage`。

## Python 侧

`services/py/quant_io/notify/slack_webhook.py` + `quant_core/services/notification_service.py` 仍保留作为兜底 / Python 自调路径，但 watch 主路径已完全迁到 NestJS。后续如果 Python 侧也要走多 IM，应通过 Flight 调 channel ops，而不是再写第二份 SDK。
