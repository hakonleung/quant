# 模块 08 — 通知（notifications）

## 1. 职责

把项目内"值得用户即时知晓"的事件推送到 IM。**v1 渠道：Slack**（incoming webhook + 可选 bot token）。

模块不产生事件 —— 只承接事件、限流去重、按 channel 投递、记录回执。事件源包括：

- 数据更新作业失败（kline / meta 死信连续 ≥ 3 次）
- LLM quota 即将耗尽 / 长任务异常退出
- 用户主动订阅的筛选 / 形态告警命中（v2，先打桩留接口）

**不负责**：UI 内通知中心（v2 再做）、邮件 / Webhook 转发（v2，本模块 channel 抽象保留扩展点）、微信 / 飞书等其它 IM（v2）。

## 2. 端口与核心实体

```python
# services/py/quant_core/domain/types/notification.py
@dataclass(frozen=True, slots=True)
class Notification:
    id: str                       # uuid7；同一 id 的重复投递视为 dedupe
    severity: Literal["info", "warn", "error", "fatal"]
    title: str                    # ≤ 64 字
    body: str                     # markdown，≤ 2000 字
    source: str                   # "kline.sync" / "llm.quota" / "screen.alert" / ...
    related_codes: tuple[str, ...]   # 相关股票（裸 6 位 code），可空
    trace_id: str
    created_at: datetime          # UTC

# services/py/quant_core/ports/notifier.py
class Notifier(Protocol):
    name: str                     # "slack_webhook" / "slack_bot" / ...
    def send(self, n: Notification) -> NotifierResult: ...

@dataclass(frozen=True, slots=True)
class NotifierResult:
    delivered: bool
    provider_msg_id: str | None   # Slack 返回的 ts（消息时间戳）
    error: str | None
```

NestJS 侧暴露 HTTP / 内部事件总线两路投递入口；Python 侧也可通过 Flight op `emit_notification` 推送。两条入口共享同一份 channel 路由表。

## 3. 渠道（v1）

| 渠道 | 适配器 | 备注 |
|---|---|---|
| Slack incoming webhook | `SlackWebhookNotifier` | 默认主路；最简，单频道，按 webhook URL 路由 |
| Slack bot token | `SlackBotNotifier`（可选） | 多频道 / 线程回复 / 用户 @ 提及；启用条件见下 |

**默认主路 = Slack incoming webhook**。原因：

- 最少配置（一个 URL 即可），无需 OAuth 流程
- Slack 官方 markdown 渲染稳定，支持 attachments / blocks
- 限流文档清晰（每秒 1 条 / webhook，突发 ≤ 10）
- 单用户 / 小团队场景下足够用；需要更复杂能力时切到 bot token

何时切到 bot token：

- 需要把不同 source 路由到不同频道（webhook 是一频道一 URL，太多 URL 难维护）
- 需要在已有消息上回线程（运维续报 / 同事 @ 提醒）
- 需要历史消息检索（Slack search API 必须 bot token）

`.env`：

```bash
NOTIFY_PRIMARY=slack_webhook
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...
SLACK_DEFAULT_USERNAME=quant-bot                  # 可选：覆盖 webhook 配置时的 display name
SLACK_DEFAULT_ICON_EMOJI=:chart_with_upwards_trend:

# 可选：bot token 模式（启用即覆盖 webhook 主路）
NOTIFY_PRIMARY=slack_bot
SLACK_BOT_TOKEN=xoxb-...
SLACK_DEFAULT_CHANNEL=#quant-alerts
```

启动校验：主路对应的 secret 必须存在，否则启动失败（与 `data-sources.md` §10 规则一致）。

## 4. 路由与限流

### 4.1 路由表（按 source + severity）

```yaml
# config/notifications.yaml
rules:
  - source: kline.sync
    severity_in: [error, fatal]
    channels: [slack_webhook]
    slack_channel_override: "#quant-data"     # 仅 slack_bot 模式有效；webhook 模式忽略
    dedupe_window_min: 30                     # 同 source 同 trace_id 30 分钟去重

  - source: llm.quota
    severity_in: [warn, error]
    channels: [slack_webhook]
    dedupe_window_min: 60

  - source: screen.alert                      # 用户主动订阅
    severity_in: [info]
    channels: [slack_webhook]
    dedupe_window_min: 5
```

匹配第一条命中规则即停止。无匹配规则 → 落 `data/_audit/notifications/dropped.jsonl`，不投递。

### 4.2 限流

- **每渠道**：令牌桶（参考 `data-sources.md` §RateLimit），Slack incoming webhook 默认 `requests_per_min: 50`（官方上限 60；留 10 条余量给手动测试）
- **每 source**：可选独立桶，默认 `severity=info` 类 `requests_per_min: 12`，避免高频筛选告警淹没频道

超过限流 → 排队（短，最多 30s）；仍超 → 丢弃并写 `dropped.jsonl`。

### 4.3 去重

`(source, dedupe_key)` 写入 `KeyValueStore`，TTL = `dedupe_window_min`。`dedupe_key` 默认值：

- `kline.sync`：`f"{source}:{date.today()}"` —— 同一天的同类失败合并为一条
- `llm.quota`：`f"{source}:{provider}"` —— 同一 provider 一小时一条
- `screen.alert`：`f"{rule_id}:{','.join(sorted(related_codes))}"` —— 同一规则同一命中集合 5 分钟一条

调用方可在创建 `Notification` 时通过 `meta.dedupe_key` 显式覆盖。

## 5. 服务

```python
class NotificationService:
    def __init__(
        self, channels: dict[str, Notifier], rules: list[Rule],
        rate_limits: RateLimitTable, dedupe: KeyValueStore, audit: AuditLog,
    ) -> None: ...

    def emit(self, n: Notification) -> NotificationOutcome: ...
```

`emit` 流程：

1. 路由匹配 → 命中 channel 列表（无命中 → `dropped`）
2. 每个 channel：检查 dedupe（命中 → `deduped`）→ 检查 rate limit（满 → 排队 / 丢弃）
3. 实际投递；写 `data/_audit/notifications/<date>.jsonl`：

```json
{"id":"...","source":"kline.sync","severity":"error","channel":"slack_webhook","outcome":"delivered","provider_msg_id":"1730000000.001234","trace_id":"...","ts":"..."}
```

## 6. NestJS 接入

### 6.1 触发入口

| 入口 | 用途 |
|---|---|
| `NotificationService.emit(n)`（Nest 内部 DI） | 业务模块直接注入，事件即推 |
| `POST /api/internal/notifications`（仅 127.0.0.1） | Python 侧通过 NestJS 反向投递；用 `x-internal-token` 头校验 |
| Flight op `emit_notification` | Python 直推（紧急路径，绕开 NestJS） |

> 直接路径与 Flight 路径共享同一 `NotificationService`（在 NestJS 进程内），保证去重 / 限流口径一致。Python 的 Flight op 实质上是 RPC 反向调用 Nest 暴露的服务接口。

### 6.2 模板

每个 source 对应一个模板，渲染成 Slack 的 [Block Kit](https://api.slack.com/block-kit) 结构（webhook + bot 都支持）：

```ts
// apps/api/src/modules/notifications/templates/kline-sync-failed.ts
export const klineSyncFailed = (ctx: { codes: string[]; trace_id: string }) => ({
  title: `K线同步失败：${String(ctx.codes.length)} 只股票连续失败`,
  body: [
    `*trace_id*: \`${ctx.trace_id}\``,
    '',
    '*受影响股票*：',
    ctx.codes
      .slice(0, 10)
      .map((c) => `• \`${c}\``)
      .join('\n'),
    ctx.codes.length > 10 ? `_…（共 ${String(ctx.codes.length)} 只）_` : '',
  ]
    .filter(Boolean)
    .join('\n'),
});
```

模板纯函数（核心资产），渲染结果送入 `Notification.title/body`。Slack 的 mrkdwn 与 GitHub Markdown 略有差异（粗体 `*foo*`、行内代码 `` `foo` ``、**不**支持 `**bold**`） —— 模板内必须按 mrkdwn 写。

`SlackWebhookNotifier` 投递时把 `(title, body)` 包成单 `section` block：

```json
{
  "username": "quant-bot",
  "icon_emoji": ":chart_with_upwards_trend:",
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "..." } },
    { "type": "section", "text": { "type": "mrkdwn", "text": "..." } }
  ]
}
```

## 7. 性能预算

| 指标 | 预算 |
|---|---|
| `emit` P50 延迟（含投递） | < 500ms |
| `emit` P95 延迟 | < 2s |
| 单分钟最大投递数（默认配置） | 50 条 |
| 去重 KV 内存占用 | < 5MB（5 万条 key） |

## 8. 测试要求

### 8.1 unit

- 路由匹配（多规则优先级、severity 过滤）
- 去重 key 生成（默认值 + 显式覆盖）
- 模板渲染（边界：codes 列表 0 / 1 / 11 项；mrkdwn 转义：含 `*` / `_` 的股票名）

### 8.2 integration

- 注入 fake `Notifier` + 内存 KV，跑完整 emit 流程：
  - 命中 → delivered
  - 第二次命中（同 key, 窗口内） → deduped
  - 触发 rate limit → 排队 → delivered / 丢弃
  - 路由未匹配 → dropped + 写入 dropped jsonl

### 8.3 contract（仅手动）

- 真实 Slack incoming webhook：发一条 mrkdwn + Block Kit，确认渠道侧渲染正常；CI 不跑（webhook 一旦泄露需要重建）

## 9. 风险与备注

- **Slack mrkdwn 与 GitHub Markdown 差异**：`**bold**` 不识别（必须 `*bold*`）；表格无原生支持（用 code block 模拟）；超长正文截断到 3000 字符（block 上限）
- **webhook 频道绑定死**：incoming webhook 一旦创建就锁定一个频道，需要多频道路由就要么开多个 webhook + URL 列表，要么切 bot token 模式
- **`provider_msg_id`**：webhook 模式拿不到 ts（Slack 不返回），audit 字段只在 bot 模式有值
- **隐私**：通知正文含 `trace_id`，但**不**含用户密钥 / token / 财务数据；模板里禁止 `process.env` / `cfg.secrets` 注入
- **可观测性**：所有投递都有 audit jsonl；UI `/admin/notifications` 展示最近 N 天发送统计（v2）
