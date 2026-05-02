# 集成 — 数据源（data-sources）

## 1. 目标

为每类数据（meta、kline、news、reports）提供**多数据源 + 自动 fallback + 增量更新 + 错误恢复**的统一框架。

## 2. 端口

每种数据有自己的 `*Source` 端口（见对应模块文档），通用复用：

```python
# ports/data_source.py
class DataSource(Protocol):
    name: str                          # "akshare" / 后续接入的源
    priority: int                      # 越小越优先
    def healthcheck(self) -> SourceHealth: ...
```

```python
@dataclass(frozen=True, slots=True)
class SourceHealth:
    available: bool
    latency_ms: int | None
    quota_remaining: int | None
    last_error: str | None
```

## 3. Fallback 链

`SourceChain` 是 N 个同类 source 的有序列表 + 失败转移规则：

```python
# services/source_chain.py
class SourceChain(Generic[T_Source]):
    def __init__(self, sources: list[T_Source], retry: RetryPolicy) -> None: ...
    def call(self, fn: Callable[[T_Source], R]) -> R:
        """
        从 priority 最高的 source 开始；失败按 retry 策略重试；仍失败则降级到下一个。
        全部失败 → raise SourceChainExhausted（含每个 source 的错误详情）。
        """
```

调用方：

```python
chain = SourceChain([AKShareKlineSource()], retry=RetryPolicy(...))
bars = chain.call(lambda s: s.fetch_range("600519", start, end))   # 裸 6 位 code
```

> v1 `kline` / `meta` chain 都只配置了 AKShare 一个源；保留 N≥2 的端口形态是为了后续接入二源（候选见 `docs/todo-enhancement.md`）。

业务代码不需要处理"哪个源"——chain 透明降级。日志会记录每次切换。

## 4. 重试策略

```python
@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    backoff_base_ms: int = 200
    backoff_factor: float = 2.0
    backoff_jitter_ratio: float = 0.2
    retryable_errors: tuple[type[Exception], ...] = (TimeoutError, RateLimitError, TransientNetworkError)
```

- 重试只针对**瞬时错误**；4xx 业务错误一律不重试（直接降级或失败）
- 总等待时间封顶（不让重试拖死整个作业）

## 5. 增量水位（watermark）

每种数据 + 每个 entity 维护"上次成功取到哪里"：

```
data/<group>/_state/watermarks.json
{
  "kline.daily": {
    "by_code": {
      "600519": { "last_date": "2026-04-30", "last_adj_factor": "1.0", "updated_at": "..." },
      ...
    }
  },
  "news": {
    "global": { "last_published_at": "2026-05-01T03:00:00Z", "updated_at": "..." }
  }
}
```

> 注意：`code` 用裸 6 位字符串（与 `docs/modules/01-stock-meta.md` 一致）。

- 写水位**必须晚于**写数据：先 `repo.append(...)`，再 `state.put(...)`
- 写数据 + 写水位**必须原子**：用 staging file + rename，或事务
- 失败：水位不前进，下次自然重跑

## 6. 增量调度

**v1 调度由 NestJS 端的 BullMQ + 内置 Cron 承担**（详见 `docs/modules/09-update-orchestration.md`）。Python 侧的 source / repo 只暴露纯 fetch / persist 能力，由 NestJS 编排：

- Cron 表达式 `0 0 */1 * * *`（每 60 分钟）+ 启动后立即跑一次
- 触发面有两条：cron 周期扫描 + HTTP 读时按需补
- 每条 source 类（meta / kline）独立 BullMQ 队列、独立并发与限流

> 早期的方案曾设想在 Python 端用 `apscheduler` 跑调度。现在的拓扑下 NestJS 已经是流量与编排入口，再在 Python 起一个调度器会带来双源 / 状态同步问题，故收敛到 NestJS 一处。

Python 侧的 service 只需提供形如 `run_full_sync()` / `enrich_one(code)` / `sync_one(code)` 的幂等入口，调度由调用方决定。

## 7. 死信队列（DLQ）

失败任务入死信，独立 parquet：

```
data/_dead_letter/
├── kline.parquet
├── news.parquet
└── reports.parquet
```

每行：

```python
@dataclass(frozen=True, slots=True)
class DeadLetterEntry:
    job: str                        # "kline.daily.fetch"
    entity_key: str                 # "600519"   （裸 6 位 code）
    payload: dict[str, Any]         # 重跑所需参数
    error_code: str
    error_message: str
    failed_at: datetime
    attempt_count: int
```

启动时 / 调度时扫死信：

- `attempt_count < 3`：重排到下次调度，attempt_count++
- `attempt_count >= 3`：写告警，等人工介入

人工修复后：从 UI / CLI 触发"重跑死信"，成功后从队列移除。

## 8. 审计日志

每次 ScheduledJob 运行结束，写一行：

```
data/_audit/<date>.jsonl
{ "job": "kline.daily.fetch", "started_at": "...", "ended_at": "...", "succeeded": 5430, "failed": 12, "skipped": 0, "duration_ms": 53210, "trace_id": "..." }
```

UI `/admin/data` 读最近 N 天审计，展示成功率趋势。

## 9. 配置

`config/data_sources.yaml`：

```yaml
meta:
  sources:
    - name: akshare
      priority: 1
      kind: AKShareStockMetaSource
  retry:
    max_attempts: 3
    backoff_base_ms: 200

kline:
  sources:
    - name: akshare
      priority: 1
      kind: AKShareKlineSource
      rate_limit_per_sec: 4         # 与 NestJS KlineWorker 令牌桶一致
  retry:
    max_attempts: 3
    backoff_base_ms: 5000

news:
  sources:
    - name: akshare_news
      priority: 1
      kind: AKShareNewsSource
  retry: { max_attempts: 2 }

# 其它源（待接入，候选见 docs/todo-enhancement.md）：保留位以便 priority 顺序可扩展
```

启动时 pydantic 校验；密钥（如未来接入需 token 的源时）缺失 = 启动失败。

## 10. 安全

- 所有 token / API key 走 `.env`，pydantic-settings 加载
- `.env.example` 进 git，`.env` gitignore
- 启动时 mask 显示已加载哪些 token（不打印值）
- 日志中 token 必须 mask（用 `pydantic.SecretStr`）

## 11. 测试要求

### 11.1 unit

- `RetryPolicy`：哪些错误重试、哪些不重试、退避计算
- `SourceChain`：主源失败切换、全部失败抛 `SourceChainExhausted`、健康检查跳过坏源
- 水位计算：增量起点选择

### 11.2 integration

- 用 fake source（注入可控失败）跑 chain
- 增量任务：跑两次，第二次只取增量
- DLQ：注入持续失败 → 进 DLQ → 修好后重跑成功

### 11.3 contract

- 每个真实 source 有 vcr-fixture：录制一次正常响应 + 一次失败响应；CI 回放，不依赖外网

## 12. 监控指标（v2）

- `source_call_total{source, status}`
- `source_call_latency_ms{source}`
- `dlq_size{job}`
- `watermark_lag_seconds{job, entity}`

v1 仅写 jsonl 审计 + 文件 marker；v2 接 Prometheus。

## 13. 风险与备注

- 同一只股票某一天**两个源给的不同数据**：以主源为准，兜底源仅在主源失败时用；切换后下一次主源恢复时**强制对账一次**——发现差异写 `_audit/discrepancy.jsonl`
- v1 主路 = AKShare（爬虫底，schema 不稳定）：所有字段视为 optional，pydantic 校验出错时降级（如有兜底源，否则跳过该 entity 进死信）；新增字段忽略（前向兼容），关键字段缺失即丢弃
- AKShare 限流：单端点 ~ 5 req/s 是观测下限，KlineWorker 的令牌桶配置（`per_sec: 4`）必须保守 —— 宁可慢不要被封段
- 兜底源待接入（候选与触发条件见 `docs/todo-enhancement.md` 的 stock-meta §2）；接入后才能验证 SourceChain 的 fallback 链路
