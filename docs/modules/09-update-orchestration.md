# 模块 09 — 更新编排（update-orchestration）

## 1. 职责

把 **meta** 与 **kline** 两类缓存的"何时同步、按什么顺序、限多大并发"集中收拢到 NestJS 进程，让 Python 侧只负责无状态的 fetch / compute / persist。两个触发面：

- **定时**：NestJS cron job，启动时立即跑一次，之后每 60 分钟一次（详见 §3）
- **读时**：HTTP API 命中 stock-meta / kline 数据时，先看本地缓存是否齐全；缺失就把 code 入队、立即返回当前缓存（即"读时陈旧，写时按需补"）

**不负责**：

- 实际拉取与落盘（在 Python `quant_io` + `quant_cache` 里，本模块只是 RPC 调用方）
- 长任务（筛选 / 形态 / 舆情）的进度推送 —— 那是 SSE / Flight stream，不进队列
- 死信处理细节 —— 委托给 `data-sources.md` §7 + `rfcs/0002-incremental-update-recovery.md`

## 2. 队列拓扑

NestJS 内部用 BullMQ（Redis 后端；v1 单机本地 Redis 起一个进程；v2 接 cluster Redis）。两条独立队列、两类独立 worker：

```
                              ┌────────────────────────┐
                              │  NestJS API gateway    │
                              │                        │
   ┌───── HTTP read ─────────►│  StockMetaController   │
   │                          │  KlineController       │
   │                          │  (read-time triggers)  │
   │                          │                        │
   │                          │  CronOrchestrator      │
   │                          │  @Cron('0 */60 * * * *')│
   │                          └──┬───────────────┬─────┘
   │                             │ enqueue       │ enqueue
   │                             ▼               ▼
   │                       ┌──────────┐    ┌──────────┐
   │                       │  meta    │    │  kline   │
   │                       │  queue   │    │  queue   │
   │                       └────┬─────┘    └────┬─────┘
   │                            │               │
   │                            ▼               ▼
   │                       ┌──────────┐    ┌─────────────────────┐
   │                       │ MetaWorker│    │ KlineWorker         │
   │                       │ (1 conc.) │    │ (rate-limit-aware,  │
   │                       │           │    │  N conc., backoff)  │
   │                       └────┬─────┘    └────┬────────────────┘
   │                            │               │
   │                            └───────┬───────┘
   │                                    ▼  Arrow Flight
   │                          ┌─────────────────────┐
   └──────── HTTP write ─────►│  Python quant_rpc   │
                              │  (fetch / compute /  │
                              │   persist)           │
                              └─────────────────────┘
```

为什么 BullMQ：

- 已有 Redis（v2 缓存切换路径会用），不引入额外组件
- 内置去重、延迟、重试、并发上限、暂停 —— 我们不需要发明
- TS 原生类型，与 Nest 集成成熟（`@nestjs/bullmq`）

为什么两条队列分开（不共享）：

- 优先级不同：日线在交易日下午 3 点后是热点流量，meta 是长尾增强
- 限流模型不同：meta 调 XQ 单股 ~ 200ms，kline 受数据源限流强约束（详见 §5）
- 失败语义不同：meta 缺失 industries 不影响读路径，kline 缺最新一日影响筛选 → 告警阈值不同

## 3. 定时调度

**起点**：NestJS 启动后**立即**触发一次（不等到下一个整点），之后每 **60 分钟**触发一次。这与早期"北京时间 15:15 开始 / 每小时"的提议有差异 —— 改动原因：

- 启动后立即跑保证刚部署 / 重启的环境第一时间补缓存，无需等 ≤ 1 小时
- 60 分钟整窗口比 "15:15 起 / 每小时整点" 更简单：cron 表达式 `*/60 * * * *` 就够了，不需要业务时间偏移
- 北京时间 15:00 收盘后的"急刷"由 §4 的读时触发兜底（用户打开筛选页 → 自动入队）；编排无需特意挑那个窗口

实现：

```ts
// apps/api/src/modules/orchestration/cron.orchestrator.ts
@Injectable()
export class CronOrchestrator implements OnModuleInit {
  constructor(
    @InjectQueue('meta') private readonly metaQueue: Queue<MetaJob>,
    @InjectQueue('kline') private readonly klineQueue: Queue<KlineJob>,
    private readonly inspector: CacheInspector,
  ) {}

  /** 每 60 分钟一次。Cron 表达式六字段（s m h d M dow） */
  @Cron('0 0 */1 * * *')
  async tick(): Promise<void> {
    await this.scan();
  }

  /** 启动后立即跑一次；OnModuleInit 在所有模块初始化完成后触发，
   *  此时队列与 worker 已就绪。 */
  async onModuleInit(): Promise<void> {
    // 用 setImmediate 解耦启动期的 init chain（避免 worker 还没 ready 就投递）
    setImmediate(() => {
      void this.scan().catch((err) => {
        this.logger.error('initial cron scan failed', err);
      });
    });
  }

  private async scan(): Promise<void> {
    const traceId = newTraceId();
    const incomplete = await this.inspector.findIncompleteMeta(traceId);
    const stale = await this.inspector.findStaleKline(traceId);
    await this.metaQueue.addBulk(
      incomplete.map((code) => ({ name: 'enrich', data: { code, trace_id: traceId } })),
    );
    await this.klineQueue.addBulk(
      stale.map((code) => ({ name: 'sync', data: { code, trace_id: traceId } })),
    );
    this.logger.log(
      `cron scan trace_id=${traceId} meta_enqueued=${String(incomplete.length)} kline_enqueued=${String(stale.length)}`,
    );
  }
}
```

`CacheInspector` 接口：

```ts
export interface CacheInspector {
  /** 通过 Flight 拉 list_stock_meta_all，返回 industries === '' 的 codes（裸 6 位） */
  findIncompleteMeta(traceId: string): Promise<readonly string[]>;

  /** 通过 Flight 拉 kline 状态：返回 last_date < lastTradingDay() 的 codes */
  findStaleKline(traceId: string): Promise<readonly string[]>;
}
```

> 实现细节：`lastTradingDay()` 调用 Python 侧 `domain/rules/calendar.py`，返回北京时间最近一个收盘日（节假日逻辑放 Python 一处）。

## 4. 读时触发

每个 HTTP 入口在返回结果前，把"本次响应里哪些 code 缓存不全"丢给 inspector，由 inspector 入队后台补。响应**不等待**入队结果 —— 用户当次请求拿到的是当前缓存内容（含 stale 行），下次刷新就更新。

```ts
// apps/api/src/modules/stock-meta/stock-meta.controller.ts
@Get(':code')
async getOne(@Req() req: Request, @Param('code') code: string): Promise<StockMetaDto> {
  const dto = await this.service.get(code, traceId(req));
  if (dto.industries === '') {
    void this.metaQueue.add('enrich', { code, trace_id: traceId(req) }, {
      jobId: `enrich:${code}`, // 去重：同 code 已入队则忽略
    });
  }
  return dto;
}

@Get(':code/kline')
async getKline(...): Promise<KlineRowDto[]> {
  const rows = await this.service.getRange(code, start, end, traceId);
  if (this.inspector.isKlineStale(code, rows)) {
    void this.klineQueue.add('sync', { code, trace_id: traceId }, {
      jobId: `sync:${code}`,
    });
  }
  return rows;
}
```

去重靠 BullMQ 的 `jobId` ：同一 code 已在排队 / 运行中则不重复入队。**`fire-and-forget` 模式**用 `void` 显式标注，避免 lint 把它当成 floating promise。

## 5. KlineWorker 限流处理

数据源对 kline 拉取限流敏感（AKShare 单端点 ~ 5 req/s，超了可能掉 IP 段），worker 必须主动配合：

### 5.1 令牌桶

```ts
@Injectable()
export class KlineFetchRateLimiter {
  // 每秒 4 次（保守留 20% 余量），突发 ≤ 8
  private readonly bucket = new TokenBucket({ ratePerSec: 4, burst: 8 });

  async acquire(traceId: string): Promise<void> {
    const waitMs = this.bucket.tryAcquireOrWaitTime();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}
```

Worker 的 processor 在每次 Flight 调用前 `await rateLimiter.acquire(traceId)`。

### 5.2 服务端 429 / `RATE_LIMITED` 的反压

如果 Python 侧返回 `QuantError(code=RATE_LIMITED)`（`SOURCE_UNAVAILABLE` 也按瞬时错误对待），worker 不立即重试，而是**通过 BullMQ 把任务延后**：

```ts
async process(job: Job<KlineJob>): Promise<void> {
  await this.rateLimiter.acquire(job.data.trace_id);
  try {
    await this.flight.doGet('sync_kline_for_code', job.data, { traceId: job.data.trace_id });
  } catch (err) {
    if (err instanceof QuantError && (err.code === 'RATE_LIMITED' || err.code === 'SOURCE_UNAVAILABLE')) {
      const backoffMs = this.backoff.next(job.attemptsMade);   // 指数退避 + jitter
      await job.moveToDelayed(Date.now() + backoffMs);
      return;
    }
    throw err;
  }
}
```

`moveToDelayed` 是 BullMQ 提供的"暂存到延迟队列"原语 —— 任务保持 `attemptsMade`，等到 delay 到期重新入主队列。这样既不堵 worker（其它非限流 code 可继续跑），也不刷数据源（被限流的 code 真的等够时间）。

退避参数：

```ts
const klineBackoff = new ExponentialBackoff({
  baseMs: 5_000,             // 第一次延迟 5s
  factor: 2.0,
  maxMs: 15 * 60_000,        // 上限 15 分钟（一个 cron 周期内必能再试至少一次）
  jitterRatio: 0.2,
});
```

### 5.3 全局熔断

如果 1 分钟内同一队列 ≥ 30% 任务返回 `RATE_LIMITED`，触发 worker 级**暂停 5 分钟**（`queue.pause()`），同时发 `severity=warn` 通知（详见 `docs/modules/08-notifications.md` §4.1）。暂停结束自动恢复。

## 6. 任务定义

### 6.1 MetaJob

```ts
type MetaJob =
  | { kind: 'enrich'; code: string; trace_id: string }   // 单股 fetch_one + upsert
  | { kind: 'full_sync'; trace_id: string };             // 强制全量 base sync（极少用）
```

Worker 行为：

- `enrich`：调 Flight op `enrich_stock_meta_for_code(code)` → 带 XQ industries / list_date / float_pct 的完整行 upsert
- `full_sync`：调 `run_stock_meta_full_sync()`（重新拉 `stock_info_a_code_name` 全表，覆写文件） —— 不在 cron 里自动触发，只接受手工 CLI / `POST /api/admin/meta/full-sync`

并发：1（避免多个 enrich 同时改一个 parquet 文件 —— 文件级锁可保护，但单并发更省心，吞吐 200ms × 5500 ≈ 18 分钟，能在两个 cron 周期内跑完）。

### 6.2 KlineJob

```ts
type KlineJob =
  | { kind: 'sync'; code: string; trace_id: string }     // 单股增量到最新交易日
  | { kind: 'recompute'; code: string; trace_id: string };  // 除权日全量回算（数据源在 sync 时检测到 adj_factor 变化时返回特殊 code，触发这条）
```

Worker 行为：

- `sync`：调 Flight op `sync_kline_for_code(code)`，Python 内部决定增量 vs 全量（基于 adj_factor）
- `recompute`：等价于 `sync` 但跳过 adj_factor 检测分支，直接全量回算

并发：4（受 §5.1 令牌桶约束实际不会超过 4 req/s）。

## 7. 配置

```yaml
# config/orchestration.yaml
cron:
  scan_interval: '0 0 */1 * * *'   # 每 60 分钟
  run_on_startup: true             # 启动后立即跑一次

queues:
  meta:
    concurrency: 1
    backoff:
      baseMs: 1000
      factor: 2.0
      maxMs: 300000
  kline:
    concurrency: 4
    rate_limit:
      per_sec: 4
      burst: 8
    backoff:
      baseMs: 5000
      factor: 2.0
      maxMs: 900000
    circuit_breaker:
      window_sec: 60
      threshold_ratio: 0.3
      pause_sec: 300
```

## 8. 性能预算

| 场景 | 预算 |
|---|---|
| Cron `scan` 整体耗时（5500 codes，含 inspector RPC） | < 3s |
| `MetaWorker` 单 enrich 任务（含 fetch_one + upsert） | < 500ms |
| `KlineWorker` 单 sync 任务（增量 1~3 天） | < 800ms |
| 一个 cron 周期内能跑完的 meta enrich 数 | ~ 7000 条（@ 单并发 500ms） |
| 一个 cron 周期内能跑完的 kline sync 数 | ~ 14000 条（@ 4 并发 800ms） |

实际全市场 ~ 5500，单周期内能跑完，无积压。

## 9. 测试要求

### 9.1 unit

- `CacheInspector.findIncompleteMeta`：mock Flight 返回 N 行，含 K 行 industries 空 → 返回 K
- `KlineFetchRateLimiter`：突发 8 + 持续；溢出 wait 时长 = 桶恢复时间
- `ExponentialBackoff`：阶梯计算 + max 截断 + jitter 范围

### 9.2 integration

- BullMQ 内存模式 + fake Flight client：模拟一次 cron scan，断言两条队列都收到正确 jobId
- 限流场景：fake Flight 第 N 次抛 `RATE_LIMITED` → 任务进 delayed → delay 到期重新执行成功
- 熔断：批量注入 RATE_LIMITED → queue.pause → 5 分钟后 resume

### 9.3 contract

- 与 Python Flight 的契约：`enrich_stock_meta_for_code` / `sync_kline_for_code` op 存在、入参 schema 一致、错误码（`RATE_LIMITED` / `SOURCE_UNAVAILABLE` / `INVALID_ARGUMENT`）能正确映射回 TS

## 10. 风险与备注

- **冷启动队列堆积**：首次启动 5500 codes 全入 meta 队列，单并发跑约 18 分钟。可接受 —— 期间 HTTP 读路径仍然返回 stale 数据，UI 用户能正常用
- **Redis 单点**：v1 单机本地 Redis；进程 / 主机重启 → BullMQ 自动 recover delayed jobs；Redis 数据丢失 → 下个 cron tick 全量重扫，最多丢一窗口的状态信息
- **去重 jobId 冲突**：`jobId: enrich:600519` 在同一队列只允许一份；如果上一个 enrich 还在 active 时新请求来了，会被忽略 —— 这是想要的语义（不要重复打数据源）
- **read-time enqueue 的失败**：`void this.metaQueue.add(...)` 失败 → 仅日志，不影响 HTTP 响应；下次读路径或下次 cron 自然兜底
- **观测**：每次 cron tick 写一行 `data/_audit/orchestration/<date>.jsonl`；BullMQ Dashboard（`@bull-board/api`）挂在 `GET /admin/queues`（v2 加鉴权后开放）
