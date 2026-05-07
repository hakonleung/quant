# Notifications — 通知投递

## 功能

- 把 watch hit / cron 失败 / 数据告警等事件投递到外部通道。
- v1 仅 Slack webhook（NestJS 侧 `SlackWebhookWatchNotifier`），结构上预留多通道。

## 实现

| 层        | 位置                                                                               | 说明                                                              |
| --------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Format    | `apps/api/src/modules/watch/domain/format.ts`                                      | 纯文本 mrkdwn 渲染（commit 1e51000：去掉 attachment / Block Kit） |
| Evaluate  | `apps/api/src/modules/watch/domain/evaluate.ts`                                    | `WatchCondition` 求值（Decimal-only）                             |
| Sender    | `apps/api/src/modules/watch/adapters/slack-webhook-notifier.ts`                    | `undici.fetch` + 可选 `HTTPS_PROXY`                               |
| Python 侧 | `quant_io/notify/slack_webhook.py` + `quant_core/services/notification_service.py` | 兜底 / 旧路径，仍在但 watch 主路径已迁到 NestJS                   |
| 触发点    | NestJS `WatchService` 边沿命中、orchestration worker 死信                          |                                                                   |

## 消息格式

单一 `text` 字段，三行 mrkdwn：

```
*<name> [<code>]*
<emoji> *<signed pct>* <emoji>   <price><unit>
<conditions joined by " · ">
```

- 涨红跌绿：`:large_red_square:` / `:large_green_square:`。
- 单位：A 股 ¥、HK HK$、US $。
- 条件文案样例：`pct(close, prev_close) >= 5%`、`abs(close) <= 100`。

## 缓存策略

- **去重**：相同 `(channel, dedupe_key)` 在 TTL 内只发一次；`FileKeyValueStore` key=`notify:<sha>`，TTL 默认 1 小时。
- **失败**：webhook 4xx 不重试（坏配置），5xx 退避 ≤ 3 次。
- 无队列持久化——通知是有损的。
