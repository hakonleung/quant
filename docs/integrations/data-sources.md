# 集成 — 数据源（data-sources）

## 1. 目标

为每类数据（meta、kline、news、reports）提供**多数据源 + 自动 fallback + 增量更新 + 错误恢复**的统一框架。

## 2. 端口

每种数据有自己的 `*Source` 端口（见对应模块文档），通用复用：

```python
# ports/data_source.py
class DataSource(Protocol):
    name: str                          # "tushare" / "akshare" / ...
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
chain = SourceChain([TushareKlineSource(), AKShareKlineSource()], retry=RetryPolicy(...))
bars = chain.call(lambda s: s.fetch_range("600519.SH", start, end))
```

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
      "600519.SH": { "last_date": "2026-04-30", "last_adj_factor": "1.0", "updated_at": "..." },
      ...
    }
  },
  "news": {
    "global": { "last_published_at": "2026-05-01T03:00:00Z", "updated_at": "..." }
  }
}
```

- 写水位**必须晚于**写数据：先 `repo.append(...)`，再 `state.put(...)`
- 写数据 + 写水位**必须原子**：用 staging file + rename，或事务
- 失败：水位不前进，下次自然重跑

## 6. 增量调度

```python
# services/scheduler.py
class Scheduler:
    def __init__(self, jobs: list[ScheduledJob], clock: Clock) -> None: ...
    def run_due(self, now: datetime) -> list[JobResult]: ...

@dataclass(frozen=True, slots=True)
class ScheduledJob:
    name: str
    cron: str                       # "0 18 * * *"
    runner: Callable[[], JobResult]
    timeout_sec: int
    on_failure: Literal["dead_letter", "alert", "ignore"]
```

v1 单进程内 schedule（用 `apscheduler`），v2 分布式（celery / arq）。

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
    entity_key: str                 # "600519.SH"
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
kline:
  sources:
    - name: tushare
      priority: 0
      kind: TushareKlineSource
      token_env: TUSHARE_TOKEN
      rate_limit_per_min: 200
    - name: akshare
      priority: 1
      kind: AKShareKlineSource
  retry:
    max_attempts: 3
    backoff_base_ms: 200

news:
  sources:
    - name: tushare_news
      priority: 0
      kind: TushareNewsSource
  retry: { max_attempts: 2 }

# ...
```

启动时 pydantic 校验；token 缺失 = 启动失败。

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
- tushare 限流敏感：rate_limit 配置必须保守，宁可慢不要被封
- akshare 来自爬虫，schema 不稳定：所有字段视为 optional，pydantic 校验出错降级到主源（如果主源在线）
