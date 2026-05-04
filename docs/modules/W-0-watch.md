# 模块 W-0 — 实盘监控（watch）

## 1. 职责

让用户对一组股票配置"价格触发器"，在交易时段内按用户给定的间隔轮询最新价，命中条件即推送 Slack。

- 支持市场：A 股 / 港股 / 美股
- 任务规模：单实例 ≤ 30 只（实际通常个位数）
- 触发判定：每条件独立，多条件 **OR**
- 不复用 kline/meta 行情缓存（实时轮询，结果不落盘）

**不负责**：下单 / 风控 / 仓位管理；UI 内告警历史时间线（v1+）；节假日表（v1+）。

## 2. 进程拓扑

```
Next.js (apps/web)               NestJS (apps/api)              Python (services/py)
─────────────────                ─────────────────              ────────────────────
W-0 watch pane  ──HTTP──▶  WatchModule (CRUD + Scheduler)  ──Flight──▶  WatchQuoteService
                              │                                          │
                              ├─ data/watch/tasks.json (atomic write)    └─ akshare per-code
                              ├─ data/watch/universe_hk.json                单只报价 + 当日缓存
                              ├─ data/watch/universe_us.json
                              └─ NotificationService (slack_webhook)
```

- **akshare 调用全部在 Python**（§2.1）。NestJS 调度器每 tick 调一次 Flight `watch.quote_one`。
- A 股 universe 复用 §01 stock-meta，**不**重复存。
- HK / US universe 落本地 JSON（仅 `{code, name, market}`），周更 + 手动刷新。

## 3. 数据模型

### 3.1 单一来源（`packages/shared/types/watch.ts`，zod → TS / Py 同步）

```ts
const Market = z.enum(['a', 'hk', 'us']);
const Baseline = z.enum(['prev_close', 'day_high', 'day_low']);

const PctCondition = z.object({
  kind: z.literal('pct'),
  baseline: Baseline,
  thresholdPct: z.string(),       // 带符号 Decimal："5" / "-2"，单位 %
});

const AbsCondition = z.object({
  kind: z.literal('abs'),
  op: z.enum(['gte', 'lte']),     // 绝对价无隐含方向，必须显式
  thresholdPrice: z.string(),     // 正数 Decimal
});

const WatchCondition = z.discriminatedUnion('kind', [PctCondition, AbsCondition]);

const WatchTask = z.object({
  market: Market,
  code: z.string(),               // 裸 code："600000" / "00700" / "AAPL"
  name: z.string(),               // 冗余存一份
  conditions: z.array(WatchCondition).min(1),
  intervalSec: z.number().int().min(5).default(20),         // 报价间隔
  pushIntervalSec: z.number().int().min(60).default(300),   // 推送节流（日内可重复）
  remaining: z.number().int().nullable().default(null),     // null = 无限
  notifySlack: z.boolean().default(true),
  enabled: z.boolean().default(true),
  createdAt: z.string(),          // ISO UTC
  lastTickAt: z.string().nullable(),
  lastPushAt: z.string().nullable(),  // 持久化 → 重启不重轰
  hitCount: z.number().int().default(0),
});

const StockBasic = z.object({ market: Market, code: z.string(), name: z.string() });
```

主键 `${market}:${code}`，同 `(market, code)` 全局唯一。

### 3.2 持久化布局

| 路径 | 内容 | 写策略 |
|---|---|---|
| `data/watch/tasks.json` | 全量 `WatchTask[]` | 原子 `tmp + rename`，写时持有进程 mutex |
| `data/watch/universe_hk.json` | `StockBasic[]` | universe 刷新时整覆盖 |
| `data/watch/universe_us.json` | `StockBasic[]` | 同上 |

## 4. 触发判定（pure，核心资产）

`apps/api/src/modules/watch/domain/evaluate.ts` —— 纯函数，零依赖、可单测：

```ts
type SpotQuote = { last: Decimal; dayHigh: Decimal; dayLow: Decimal; prevClose: Decimal };

function evaluate(quote: SpotQuote, c: WatchCondition): boolean {
  if (c.kind === 'pct') {
    const base = pickBaseline(quote, c.baseline);
    const deltaPct = quote.last.minus(base).div(base).mul(100);
    const thr = new Decimal(c.thresholdPct);
    return thr.gte(0) ? deltaPct.gte(thr) : deltaPct.lte(thr);
  }
  const thr = new Decimal(c.thresholdPrice);
  return c.op === 'gte' ? quote.last.gte(thr) : quote.last.lte(thr);
}
```

> **金额一律 `Decimal`，不用 `number`**（§2.8）。Python 侧 `Decimal`，TS 侧 `decimal.js`。

### 4.1 例子

| baseline | thresholdPct | 触发等价 |
|---|---|---|
| `prev_close` | `+5` | `(last − prevClose) / prevClose × 100 ≥ +5` |
| `day_high`   | `−2` | `(last − dayHigh)  / dayHigh  × 100 ≤ −2` |
| `day_low`    | `+1` | `(last − dayLow)   / dayLow   × 100 ≥ +1` |

| kind | op  | thresholdPrice | 触发等价 |
|---|---|---|---|
| `abs` | `gte` | `12.50` | `last ≥ 12.50` |
| `abs` | `lte` | `9.80`  | `last ≤ 9.80`  |

零阈值（pct=0）前端校验拒绝，避免方向歧义。

## 5. 交易时段（pure `isMarketOpen(market, now)`）

| Market | BJT 窗口 | 备注 |
|---|---|---|
| `a` | 09:30–11:30, 13:00–15:00 | 周末关 |
| `hk` | 09:30–12:00, 13:00–16:00 | 周末关 |
| `us` | DST: 21:30–次日 04:00；非 DST: 22:30–次日 05:00 | 跨夜 |

US DST 用纯函数 `isUsDst(utcDate)` 判定（3 月第二个周日 02:00 ET 起到 11 月第一个周日 02:00 ET 止）。v0 不查节假日 —— 非交易日 akshare 返回静态/空数据，跳过即可。

## 6. Python 侧报价服务

`services/py/quant_core/services/watch_quote_service.py`：

```python
@dataclass(frozen=True, slots=True)
class SpotQuote:
    market: Literal["a", "hk", "us"]
    code: str
    last: Decimal
    day_high: Decimal
    day_low: Decimal
    prev_close: Decimal
    ts: datetime  # UTC

class WatchQuoteService:
    def fetch_one(self, market: str, code: str) -> SpotQuote: ...
```

按市场分派单 code 接口（**禁用全量 spot**）：

| Market | last + day H/L | prev_close |
|---|---|---|
| `a`  | `ak.stock_bid_ask_em(symbol=code)` | 同左（含昨收）|
| `hk` | `ak.stock_hk_hist_min_em(symbol=code, period="1")` 末行 + 当日运行高低 | `ak.stock_hk_daily(symbol=code)` 倒数第二行 close |
| `us` | `ak.stock_us_hist_min_em(symbol=code, period="1")` 同上 | `ak.stock_us_daily(symbol=code)` 同上 |

`prev_close` 在交易日内不变 → 进程内 `dict[(market, code)] -> (date, Decimal)` 缓存，命中复用。

Flight op：`watch.quote_one(market, code) -> SpotQuote`，schema 写 `proto/watch.proto` + Arrow（行情列）；错误码新增 `WATCH_QUOTE_UPSTREAM_FAIL` 入 `proto/errors.json`（§8.2）。

## 7. Universe 服务

| Market | 来源 | 接口（NestJS）| 调度 |
|---|---|---|---|
| `a` | 复用 §01 stock-meta 现有搜索 | `GET /api/stocks/search?market=a&q=...` | 现有 |
| `hk` | `ak.stock_hk_spot_em()`（**仅刷新时**全量拉一次取 code+name）| `GET /api/watch/universe?market=hk` | 周一 09:00 BJT 自动 + 手动 |
| `us` | `ak.stock_us_spot_em()` | `GET /api/watch/universe?market=us` | 同上 |

刷新走 Flight op `watch.universe_refresh(market)`，落盘交给 NestJS 写文件（保持"Python 不写非缓存类业务文件"的现有约定）。

手动刷新：`POST /api/watch/universe/refresh?market=hk|us`。

## 8. 调度器（NestJS，单进程）

`apps/api/src/modules/watch/watch.scheduler.ts` —— 与 §09 `cron.orchestrator` 同款 `setTimeout` 自驱动，不引 `@nestjs/schedule`。

```
master tick = 5s
  for each task in store where enabled:
    if !isMarketOpen(task.market, now): continue
    if lastTickAt && now < lastTickAt + intervalSec*1000: continue
    due.push(task)

  await Promise.allSettled(due.map(t =>
    flight.watchQuoteOne(t.market, t.code)  // 并发 ≤ 30
       .then(quote => process(t, quote))
       .catch(err => logQuoteFail(t, err))
  ))
  flushDirty()       // 节流：≥1 dirty 时整文件原子写

process(task, quote):
  task.lastTickAt = now
  hits = task.conditions.filter(c => evaluate(quote, c))
  if hits.length === 0: return
  if task.lastPushAt && now < task.lastPushAt + pushIntervalSec*1000: return  // 节流
  notifications.emit(buildPayload(task, quote, hits))   // source = "watch.alert"
  task.lastPushAt = now
  task.hitCount++
  if task.remaining !== null:
    task.remaining--
    if task.remaining <= 0: task.enabled = false
```

启动钩子：`OnModuleInit` 加载 `tasks.json` 进内存，注册 master tick。`OnModuleDestroy` 清 timer 并 flush。

并发与一致性：CRUD 与 scheduler 共享内存 store，所有写经 `Mutex` 串行。flush 节流到每秒最多一次。

## 9. 推送

走 §08 `NotificationService`，source = `watch.alert`，severity = `info`。

**关闭 §08 dedupe**（`dedupe_window_min: 0`），节流权完全交给 `WatchScheduler.lastPushAt + pushIntervalSec`，避免双层去重产生反直觉行为。

`config/notifications.yaml` 追加：

```yaml
- source: watch.alert
  severity_in: [info]
  channels: [slack_webhook]
  dedupe_window_min: 0
```

### 9.1 文案（pure `buildPayload`）

```
[600000] [浦发银行] [12.34] [+2.15%] #prev_close+5%, day_high-2%, >=12.00, <=9.50
```

| 段 | 计算 |
|---|---|
| `[code]` | `task.code` |
| `[name]` | `task.name` |
| `[currentPrice]` | `quote.last`，按 market 保留 2（A/HK）或 2~4（US）位小数 |
| `[currentChangePct]` | `(last/prevClose − 1) × 100`，带符号 + 2 位小数 + `%` |
| `#conditions` | 仅命中条件，逗号连接 |

条件渲染：

- pct → `${baseline}${signedPct}%` ：`prev_close+5%` / `day_high-2%`
- abs → `${opSym}${price}` ：`>=12.00` / `<=9.50`

`buildPayload` 是 `apps/api/src/modules/watch/domain/format.ts` 纯函数。

## 10. HTTP API

| Method | Path | 用途 |
|---|---|---|
| `GET /api/watch` | 列表 |
| `POST /api/watch` | 新增；`(market, code)` 冲突 → 409 |
| `PATCH /api/watch/:market/:code` | 编辑（conditions / intervals / remaining / notifySlack / enabled）|
| `DELETE /api/watch/:market/:code` | 删除 |
| `GET /api/watch/universe?market=hk\|us` | HK/US universe（A 股走 stock-meta 搜索）|
| `POST /api/watch/universe/refresh?market=hk\|us` | 触发 universe 刷新 |

入参 zod 校验；controller 极薄，业务在 `WatchService`。

## 11. 前端（cyber 风格 + Pane）

新增 `Feat.Watch = 'W-0'`（`apps/web/lib/eqty/feat.ts`），加进 `FEAT_CONFIG_MAP`：

```ts
[Feat.Watch]: { title: () => 'watch', cyber: true, defaultMinimized: true },
```

放在右栏（`gridArea: 'R3'` 或工作台预留位），与 `Status` / `Notif` 同区。

### 11.1 组件树

```
<Pane feat={Feat.Watch}>            // 沿用项目 cyber 风格，Pane 提供 corners / 折叠 / 全屏
  <WatchPanel>                      // apps/web/components/watch/watch-panel.tsx
    ├── <WatchToolbar/>             // [+ Add] / market 切换 / refresh universe
    ├── <WatchTable/>               // 每行：code / name / market / hit / lastPushAt / actions
    └── <WatchEditor/>              // dialog；新增和编辑共用
        ├── code 选择（A 股从 stock-meta 搜，HK/US 从本地 universe contains 过滤）
        ├── intervalSec / pushIntervalSec / remaining / notifySlack
        └── <ConditionsEditor/>     // 动态数组
            └── <ConditionRow/>     // kind dropdown → 切换 pct / abs 子表单
                ├── pct: baseline + signedPct
                └── abs: op + price
```

样式：`bg=term.panel` / 边框 `term.line` / 主色 `term.green`，与现有 cyber pane（Status / Notif / Search）同色板；表单控件用 Chakra 但样式覆盖到等宽字体 + 细边框。

列表规模 ≤ 30，无需虚拟化（与用户 memory 中"列表 ≥ N 必须虚拟化"不冲突，本场景天然小）。

### 11.2 数据获取

服务端组件首屏拉列表 + universe 摘要；客户端 `@tanstack/react-query` 走 polling（5s）刷新 hit 状态与 `lastPushAt`。表单 `react-hook-form + zod`（zod schema 复用 `packages/shared/types/watch.ts`）。

## 12. 跨进程契约

新增 `proto/watch.proto`：

```proto
message QuoteOneReq { string market = 1; string code = 2; }
message Quote {
  string market = 1; string code = 2;
  string last = 3;        // Decimal as string
  string day_high = 4; string day_low = 5; string prev_close = 6;
  google.protobuf.Timestamp ts = 7;
}
message UniverseRefreshReq { string market = 1; }
message UniverseRefreshAck { uint32 count = 1; }
```

新错误码（`proto/errors.json`）：

| code | 含义 |
|---|---|
| `WATCH_QUOTE_UPSTREAM_FAIL` | akshare 调用失败 / 超时 |
| `WATCH_CODE_NOT_FOUND` | universe 中找不到 code |
| `WATCH_TASK_CONFLICT` | `(market, code)` 已存在 |

## 13. 测试要点（§3）

### 13.1 unit / pure（核心资产，零 mock）

- `evaluate`：
  - pct × 三 baseline × 正负阈值 × 边界（恰好等于、跨过、未达）
  - abs × `gte` / `lte` × 边界
  - Decimal 精度（如 `12.345` vs `12.34` 的舍入）
- `pickBaseline`：三 baseline 各一例
- `buildPayload`：
  - 单条件 / 多条件混合渲染
  - 各 market 小数位
  - 正/负 changePct 带符号
- `isMarketOpen`：A/HK/US 各市场开收盘前后一分钟、周末、跨夜
- `isUsDst`：3 月第二周日切换日 / 11 月第一周日切换日 / 各月份采样

### 13.2 service / integration

- CRUD：唯一主键冲突、删除不存在、edit 保持 `createdAt` / `hitCount`
- universe：刷新覆盖写、并发刷新串行化
- scheduler（fake clock + fake quote port）：
  - 节流：`pushIntervalSec` 内不重推，超出立即推
  - `remaining` 倒计到 0 → `enabled = false`
  - 跨日（lastPushAt 跨过 BJT 0:00）：日内可重复推送规则不变
  - quote 失败：单只失败不影响其它任务推进
- `tasks.json` 持久化：写后重启 = 状态完整恢复

### 13.3 contract

- `proto/watch.proto` 旧 client → 新 server / 反向，字段新增向后兼容

## 14. 性能预算

| 指标 | 预算 |
|---|---|
| master tick 处理时间（30 任务并发）| < 500ms（不含网络）|
| 单 quote 拉取 P95 | < 1.5s |
| `tasks.json` 大小 | < 100KB（30 任务 × ~2KB）|
| universe JSON 大小 | HK ~150KB / US ~500KB |

## 15. 风险与备注

- **akshare 单 code 接口稳定性**：`stock_bid_ask_em` 偶发返回结构变化，必须 pydantic 解析并捕获 `ValidationError` → 转 `WATCH_QUOTE_UPSTREAM_FAIL`
- **港股代码格式**：akshare 港股 code 5 位带前导 0（`00700`），前端展示按原样不补/不去
- **美股代码大小写**：统一存大写
- **DST 边界**：DST 切换日窗口偏移 1h，纯函数测试必须覆盖
- **节假日**：v0 不识别；HK 中秋、US 感恩节等休市日 akshare 可能返回前一交易日数据 → 不会误触发（`prev_close` 与 `last` 一致 → deltaPct = 0），但 `day_high/day_low` 在静态数据下也保持不变，正负阈值都不会命中，安全
- **写盘抖动**：`tasks.json` flush 限流到每秒 ≤ 1 次，避免 master tick 频繁触发原子重命名
- **隐私**：推送正文仅含 code/name/价格，无密钥/账号
