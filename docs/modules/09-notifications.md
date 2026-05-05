# Notifications — 通知投递

## 功能

- 把 watch hit / cron 失败 / 数据告警等事件投递到外部通道。
- v1 仅 Slack webhook，结构上预留多通道。

## 实现

| 层 | 位置 | 说明 |
| -- | ---- | ---- |
| Port | `quant_core/ports/notifier.py` | `Notifier` 抽象 |
| Adapter | `quant_io/notify/slack_webhook.py` | Slack incoming webhook，POST JSON |
| Service | `quant_core/services/notification_service.py` | 组装消息体 + 去重 |
| 触发点 | `watch_quote_service.py` 边沿命中、orchestration worker 死信 | |

## 缓存策略

- **去重**：相同 `(channel, dedupe_key)` 在 TTL 内只发一次；存于 `file_kv_store`，key=`notify:<sha>`，TTL 默认 1 小时。
- **失败**：webhook 4xx 不重试（坏配置），5xx 退避 ≤ 3 次。
- 无队列持久化——通知是有损的。
