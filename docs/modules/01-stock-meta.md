# 模块 01 — 股票基础信息（stock-meta）

## 1. 职责

维护本地全市场 A 股股票的元信息，对外提供查询接口，并在缓存命中不全时按需触发更新（详见 `docs/modules/09-update-orchestration.md`）。

**不负责**：日线行情、新闻、研报、价格驱动分析。

## 2. 核心实体

```python
# services/py/quant_core/domain/types/stock.py
@dataclass(frozen=True, slots=True)
class QuarterlyFinancials:
    period: date                       # 报告期 YYYY-09-30 之类，季末日
    revenue: Decimal | None            # 营业总收入（元）
    operating_cost: Decimal | None     # 营业成本（元）
    net_profit: Decimal | None         # 归母净利润（元）
    net_profit_excl_nr: Decimal | None # 扣非归母净利润（元）

@dataclass(frozen=True, slots=True)
class StockMeta:
    # 现有字段
    code: str
    name: str
    name_pinyin: str
    industries: str
    list_date: date
    float_pct: Decimal                 # 派生字段：float_share / total_share
    updated_at: datetime
    # M3 新增（结构性指标，财报粒度更新）
    total_share: Decimal | None        # 总股本（股）
    float_share: Decimal | None        # 流通股本（股）
    net_assets: Decimal | None         # 最新期归母净资产（元）
    net_assets_period: date | None     # 上一行对应的报告期
    quarterlies: tuple[QuarterlyFinancials, ...]   # 最近 8 期，由旧到新
    financials_updated_at: datetime | None         # 上次抓取财报的 UTC 时间
```

设计取舍（与早期版本的对比）：

- **不存 `exchange`**：A 股 6 位代码空间在 SH/SZ/BJ 三地不重叠，必要时下游按前缀派生。前缀映射逻辑只在数据源 adapter 内部存在（用于构造 `ak.stock_individual_basic_info_xq` 所需的 `SH600519` 形式 symbol），**不写回缓存行**。
- **不存 `board` / `delist_date` / `status`**：`board` 同样可以从 code 前缀派生；缓存只保留**当前上市**股票（数据源以 `list_status="L"` 过滤），退市的下次同步直接掉行，不翻 flag。
- **`float_pct` 取代 `total_share` + `float_share`**：业务代码消费的是比率（例如换手率、市值因子的标度），原始两列一律会派生比率；存比率本身能避开股票拆分对绝对股本的扰动，且 Decimal(1) 默认对未提供该字段的来源（如 AKShare 大列表）天然兼容。
- **`industries` 是单字符串**：申万一/二/三级口径在不同源之间不一致；XQ 仅给出**一级行业名**（无三级层次）；统一拍平为 "粗到细" 的逗号串，UI 直接展示，需要查询时用 `LIKE` / `contains`。
- **`code` 是裸 6 位**：对 NL 输入、URL path、key-value 查询都最友好；无需在前端再做 `600519.SH` ↔ `600519` 的双向转换。
- **结构存 meta、比率派生在外**：估值类指标（PE/PB/PEG/市值/毛利率）随价格逐日漂移；如果都写进 parquet，每天都得重写一份完整文件。所以 meta 只存**财报粒度**变化的结构量（股本、净资产、4–8 季度财报快照），价格相关的派生字段在 `StockSnapshotDto`（见 §6.3）的 server-side 拼装层用最新 kline close 即时算出来。前端从来不直接接触结构量去算，只读派生 DTO。
- **`quarterlies` 选 8 期**：PEG 的 TTM 同比需要 5 个季度（最近 4 季 vs 上一年同期 4 季），8 期还能给毛利率/ROE 同比保留余量。`tuple` 而非 `list` 让 dataclass 仍然可哈希，与现有 frozen+slots 约定一致。
- **`Decimal` 而非 `float`**：单个总股本 8e9 股、市值 1e12 元用 IEEE-754 已经丢精度，Parquet 列一律 `string`，Python 侧 `Decimal`，TS 侧 `decimal.js`。
- **`None` 不要默认 0**：`stock_yjbb_em` 不返回扣非时不要补 0，否则 PEG 公式会计算出失真值。所有派生函数对 `None`/`<= 0` 分母直接返 `None`。

TS 侧：`packages/shared/src/types/stock-meta.ts` 直接手写（不在 `proto/` 单一源里），字段、正则、零拷贝由 `StockMetaDtoSchema` 强约束 —— 6 位数字 / `YYYY-MM-DD` / 带时区 ISO8601 / 十进制字符串。

### 2.1 派生指标（runtime 计算，不入 parquet）

| 指标 | 公式 | 说明 |
|---|---|---|
| 总市值 `mkt_cap` | `price × total_share` | `price` 取该 code 最新一日 `close_qfq`（kline cache）|
| 流通市值 `float_mkt_cap` | `price × float_share` | 同上 |
| 市净率 `pb_latest` | `mkt_cap / net_assets` | `net_assets` 用 `quarterlies` 中最新有归母净资产口径的值 |
| TTM 市盈率 `pe_ttm` | `mkt_cap / sum(quarterlies[-4:].net_profit)` | 4 季度全有效；任一为 None → `None` |
| 动态市盈率 `pe_dynamic` | `mkt_cap / annualize(latest_quarter)` | **EastMoney 风格**：`annualize = latest_quarter.net_profit × 4 / quarter_index`，其中 `quarter_index ∈ {1,2,3,4}` 由 `period.month` 推 (`3→1, 6→2, 9→3, 12→4`)。要求最新季报 `net_profit` 有效 |
| PEG `peg_ttm` | `pe_ttm / (yoy_growth_pct × 100)` | `yoy_growth_pct = (sum(q[-4:].net_profit) − sum(q[-8:-4].net_profit)) / abs(sum(q[-8:-4].net_profit))`；分母 ≤ 0 或 < 8 个季度 → `None`；`pe_ttm` 与增速同口径（都用百分数）|
| TTM 销售毛利率 `gross_margin_ttm` | `(sum(q[-4:].revenue) − sum(q[-4:].operating_cost)) / sum(q[-4:].revenue)` | 任一缺失 → `None` |

> **动态 PE 的口径必须钉死**。EastMoney 用上面的"按当前已披露季度年化"，跟"去年完整年报推全年"或"机构一致预期"出来的数都不同；本仓固定走 EastMoney 风格，避免列表的"动态市盈率"与用户在别处看到的同名指标对不上。函数实现位于 `services/py/quant_core/domain/pure/derive_metrics.py`，纯函数零 IO。

## 3. 端口与适配器

```python
# services/py/quant_core/ports/stock_meta_source.py
class StockMetaSource(Protocol):
    name: str                                # "akshare"
    priority: int                            # 越小越优先（默认 1）
    def healthcheck(self) -> SourceHealth: ...
    def fetch_all(self) -> Iterable[StockMeta]: ...
    def fetch_one(self, code: str) -> StockMeta | None: ...

# services/py/quant_core/ports/stock_meta_repo.py
class StockMetaRepo(Protocol):
    def upsert_many(self, items: Iterable[StockMeta]) -> None: ...
    def get(self, code: str) -> StockMeta | None: ...
    def get_many(self, codes: Sequence[str]) -> list[StockMeta]: ...
    def list_by_industry(self, sw_l2: str) -> list[StockMeta]: ...
    def list_all(self) -> list[StockMeta]: ...
```

**v1 适配器**（实际落地的）：

| 适配器 | 文件 | 备注 |
|---|---|---|
| `AKShareStockMetaSource` | `quant_io/sources/akshare_stock_meta.py` | **默认主源**（`priority=1`），无需 token |
| `ParquetStockMetaRepo` | `quant_cache/parquet_stock_meta_repo.py` | 单文件 `data/meta/stocks.parquet`，按 code 排序 |

> 项目目前只接入 AKShare 一家数据源；`SourceChain` 仍保留 N≥2 source 的能力，待后续接入新源（候选见 `docs/todo-enhancement.md`）时再激活 fallback。

### 3.1 AKShareStockMetaSource — 多端点 + bulk-first 策略

#### 3.1.1 端点矩阵

> akshare 的接口几乎都是爬虫包装；schema 不稳，频率不稳，但好处是免 token、覆盖全。下表是经过实测梳理、本模块**实际选用**的端点；选型逻辑详见 §3.1.2。

| 上游 | 粒度 | 单次返回 | 提供的关键字段 | RTT | 选用 |
|---|---|---|---|---|---|
| `stock_info_a_code_name()` | 全市场 | 5500 行 | `code`, `name` | ~10s | ✅ `fetch_all` 拿基础列表 |
| `stock_individual_basic_info_xq(symbol)` | 单股 | item/value 表 | `affiliate_industry`, `listed_date`, `org_short_name_cn` | 180–440ms | ✅ `fetch_one` 补行业 + 上市日 |
| `stock_individual_info_em(symbol)` | 单股 | 字段表 | `总股本`, `流通股`, 行业, 总市值快照 | ~250ms | ✅ 财报增强阶段补 `total_share` / `float_share` |
| `stock_zh_a_spot_em()` | 全市场 | 5500 行快照 | 最新价、PE 动态、PB、总市值、流通市值（**已派生**） | ~3s | ⚠️ 仅用于 sanity check，不进 cache（违反"存结构、派生在外"）|
| `stock_yjbb_em(date="YYYYMMDD")` | 全市场 / 单季度 | 5000+ 行 | `每股收益`, `营业收入`, `营业收入-同比`, `净利润`, `净利润-同比`, `净资产收益率`, `每股净资产`, `报告期` | ~1.5s/季 | ✅ **核心杠杆**：8 个 RTT 拿到全市场 8 季度财报 |
| `stock_financial_abstract_ths(symbol)` | 单股 | 多年多期 | `营业总收入`, `营业成本`, `归母净利润`, `扣非归母净利润`, `归母净资产` | ~300ms | ✅ 慢路径，补扣非 + 营业成本（毛利率必需）|
| `stock_financial_abstract(symbol)` | 单股 | 多期 | 新浪口径财务摘要 | ~250ms | ❌ 字段口径与 ths 不一致，统一用 ths |
| `stock_balance_sheet_by_quarterly_em(symbol)` | 单股 | 多季资产负债表 | 全资产负债表 | ~400ms | ❌ 数据量过大，目前只需净资产，ths 已包含 |
| `stock_profit_sheet_by_quarterly_em(symbol)` | 单股 | 多季利润表 | 完整利润表 | ~400ms | ❌ 同上 |

#### 3.1.2 抓取策略：bulk-first，per-stock 兜底

每天 15:15 BJT cron + 手动 scan 时按**两轨并行**调度：

1. **基础轨** — 每次都跑：
   - `ak.stock_info_a_code_name()` 1 次 → 全量 `code/name` upsert
2. **财报轨** — bulk + 慢补齐：
   - `ak.stock_yjbb_em(quarter)` × 8 个最近季度 → 一次性把 5500 × 8 个季度的 `revenue / net_profit / 净资产 / ROE / 报告期` 拿全。这是**核心效率杠杆**（`5500 × 200ms ≈ 18min` ⟶ `8 × 1.5s ≈ 12s`）。
   - 业绩报表**不含**扣非和营业成本；这两个字段由慢路径 `stock_financial_abstract_ths` 按 watermark 补齐：
     - 同一报告期 ≤ 7 天内已抓过 → 跳过
     - 否则进 enrich 队列，与现有 XQ 增强共享 concurrency=1
3. **股本轨** — 仅在 `total_share is None` 或上次抓 > 30 天前 → `stock_individual_info_em(code)`，由队列按 code 调度。

不再使用 `stock_zh_a_spot_em` 写 cache：它给的派生字段会被 server-side 派生函数覆盖；保留只用于回归测试时对账。

#### 3.1.3 已知盲区

- **920xxx**（北交所 2024 年新增前缀）多数不在 XQ 索引内 → `fetch_one` 返回 `None`；保留 `fetch_all` 出来的部分行（业务对北交所容忍 industries 为空）。
- **部分老北交所 4xxxxx** 行能查到 name 但 `affiliate_industry` 缺失 → `industries=""`。
- `stock_yjbb_em` 偶发 502 / 字段错位（爬虫被 EM 反爬命中）→ 抓取器内置最大 3 次指数退避；超过则该季度跳过，下个 cron 窗口重试。
- `stock_financial_abstract_ths` 个别港股代码（混入 A 股清单的）会抛 `KeyError` → 适配器内 try/log/skip，不向上抛业务异常。

`_exchange_for_code` 内部辅助：仅用于构造 XQ symbol（`{SH|SZ|BJ}{code}`）和粗筛非 A 股代码。**输出不写回 StockMeta**。

**XQ 的已知盲区**：
- 920xxx（北交所 2024 年新增前缀）多数不在 XQ 索引内 → `fetch_one` 返回 `None`；此时保留 `fetch_all` 出来的部分行（业务对北交所容忍 industries 为空）。
- 部分老北交所 4xxxxx 行能查到 name 但 `affiliate_industry` 缺失 → `industries=""`。

`_exchange_for_code` 内部辅助：仅用于构造 XQ symbol（`{SH|SZ|BJ}{code}`）和粗筛非 A 股代码。**输出不写回 StockMeta**。

### 3.2 拼音生成

```python
# services/py/quant_io/pinyin.py
def name_to_pinyin_initials(name: str) -> str: ...
```

包装 `pypinyin.lazy_pinyin(name, style=FIRST_LETTER)` + 空白/标点过滤 + 上标。离线，无网络依赖。`贵州茅台 → "GZMT"`、`*ST 国华 → "ST GH"`（`*` 与空格被剥）。

## 4. 缓存布局

```
data/meta/
├── stocks.parquet        # 当前快照（pyarrow schema 见 quant_cache/stock_meta_schema.py）
└── _state/
    └── meta.json         # KeyValueStore 后端：last_full_sync / last_partial_sync / source / record_count
```

**列表**（与 `STOCK_META_SCHEMA` 一一对应）：

| 列 | 类型 | 备注 |
|---|---|---|
| `code` | string | 主键 |
| `name`, `name_pinyin`, `industries` | string | |
| `list_date` | date32 | |
| `float_pct` | string (Decimal) | 派生 = `float_share / total_share`，仍写入便于旧调用点向后兼容 |
| `updated_at` | timestamp\[us, UTC] | 上次写入时间 |
| `total_share`, `float_share`, `net_assets` | string (Decimal, nullable) | 元/股 |
| `net_assets_period` | date32 (nullable) | 上行净资产对应的报告期 |
| `quarterlies_json` | string (nullable) | 8 期 `QuarterlyFinancials` 的 JSON 序列（按时间升序）；为简化 schema 不展开成多列；解码在 codec 内 |
| `financials_updated_at` | timestamp\[us, UTC] (nullable) | 上次抓 `stock_yjbb_em` / `stock_financial_abstract_ths` 的时间 |

> **为什么 `quarterlies` 用 JSON 列而不是 list-of-struct**：list-of-struct 在 Parquet 上的可读性差、跨 binding 行为不一致（pyarrow ↔ pandas ↔ 第三方），而 8 个季度 × 5 个 Decimal 字段一行 ≤ 600 字节，JSON 可读、迁移友好、Repo 端解码一行成本 < 50µs。等 `proto/schemas/arrow/` 落地后再迁回 list-of-struct。

**parquet 仍提交进 git**（`data/meta/stocks.parquet`）。新增字段对存储的影响：5500 行 × 600B ≈ 3.2MB，叠加既有列 ≈ 总 4MB；仓库提交可接受。

**迁移**（v1 → v2）：旧文件没有新列。`ParquetStockMetaRepo` 读时按 `STOCK_META_SCHEMA` 重投影，缺列 default-fill `null`；上层服务 + zod 都接受 `null`，业务表现是"还没抓到财报，派生列显示 —"。一次手动或 cron 触发的财报轨抓取后所有行升级到 v2 schema。

历史快照（`_history/`）当前**不**写；如需要回溯研究再通过 RFC 引入。

## 5. 同步策略

每条行的"完整度"由三位组成：

- **基础位**（来自 `fetch_all`）：`code` + `name` 必填；`industries=""` 视为缺失。
- **行业/上市日位**（来自 `fetch_one`）：`industries != ""` 视为已增强。
- **财报位**（来自 `stock_yjbb_em` + `stock_financial_abstract_ths`）：`quarterlies` 长度 ≥ 4 且最近一期 ≤ 95 天前 视为新鲜；否则进财报轨。

### 5.1 全量同步（base sync）

- 触发：首次启动 / `meta.last_full_sync` 距今 > 7 天 / 手动 CLI（`uv run python -m quant_io.sync stock-meta --full`）
- 流程：`AKShareStockMetaSource.fetch_all()` → `repo.upsert_many(...)` → 写 state
- 失败：保留旧文件（parquet 的原子 rename 保证一致性），记录到 source health

### 5.2 增量增强（per-code enrich）

- 触发：编排层（NestJS）发现某 code 的 `industries == ""` 或行不存在；详见 `docs/modules/09-update-orchestration.md` §3
- 流程：`source.fetch_one(code)` → 与本地行 merge（XQ 字段优先）→ `repo.upsert_many([merged])`
- 失败：保留旧行；该 code 下次窗口再尝试

### 5.3 财报轨（quarterly financials）

- 触发：cron 每天 15:15 BJT 跑一次 bulk；编排层 `inspector.findStaleFinancials` 把"财报位"未新鲜的 code 进 enrich 队列做慢补齐
- 流程：
  1. **bulk**：8 季度 `stock_yjbb_em` → 一次性更新 `quarterlies.{revenue, net_profit}` 与 `net_assets`（来自 `每股净资产 × total_share`，缺 total_share 时跳过净资产更新）
  2. **per-stock**：`stock_financial_abstract_ths` → 补 `operating_cost` 与 `net_profit_excl_nr`；`stock_individual_info_em` → 补 `total_share` / `float_share`
- 写时机：bulk 阶段无论是否拿全字段都覆盖 `quarterlies` 的 `revenue` / `net_profit`；per-stock 阶段是 partial merge（只动它能填的字段）
- watermark：`financials_updated_at` 同时充当 7 天去抖；同一 trading day 内多次 scan 不重复发 RPC

### 5.4 数据源 fallback

- `SourceChain[StockMetaSource]` 按 priority 顺序调用，遇到 `QuantError(code=SOURCE_UNAVAILABLE | RATE_LIMITED | TimeoutError)` → 切换次源
- 当前只配置了 AKShare；二源接入后（候选见 `docs/todo-enhancement.md`）这条链就能起作用

## 6. 查询接口

### 6.1 Python public API

```python
# services/py/quant_core/services/stock_meta_service.py
class StockMetaService:
    def __init__(self, repo: StockMetaRepo) -> None: ...
    def get(self, code: str) -> StockMeta: ...                          # 缺失 → QuantError(STOCK_NOT_FOUND)
    def get_batch(self, codes: Sequence[str]) -> list[StockMeta]: ...   # 保留输入顺序，缺失静默丢弃
    def list_by_industry(self, sw_l2: str) -> list[StockMeta]: ...      # 按 code 排序
    def list_all(self) -> list[StockMeta]: ...                          # 按 code 排序
```

### 6.2 NestJS HTTP API

| Method | Path                          | Query             | 200 Response          |
| ------ | ----------------------------- | ----------------- | --------------------- |
| GET    | `/api/stocks`                 | —                 | `StockMetaDto[]`      |
| GET    | `/api/stocks/batch`           | `?codes=a,b,c`    | `StockMetaDto[]`      |
| GET    | `/api/stocks/by-industry`     | `?sw_l2=...`      | `StockMetaDto[]`      |
| GET    | `/api/stocks/:code`           | —                 | `StockMetaDto`        |
| GET    | `/api/stocks/snapshots`       | `?codes=a,b,c`    | `StockSnapshotDto[]`  |

> 路由顺序在 controller 中**字面段先于 `:code` 通配**，否则 `/api/stocks/batch` / `/api/stocks/snapshots` 会被 `:code` 吞掉。

错误：`STOCK_NOT_FOUND` (404) / `INVALID_ARGUMENT` (400) / `INTERNAL` (500)。`META_STALE` (503) 当前未实现 —— 编排层默认提供"读时补齐"语义，缓存空了直接返 200 加触发后台填充。

### 6.3 `StockSnapshotDto` —— meta + 价格派生

```ts
// packages/shared/src/types/stock-meta.ts
export const StockSnapshotDtoSchema = z.object({
  meta: StockMetaDtoSchema,
  price: decimalString.nullable(),       // 最新一日 close_qfq
  asof: isoDate.nullable(),              // 价格对应的交易日
  derived: z.object({
    mkt_cap: decimalString.nullable(),
    float_mkt_cap: decimalString.nullable(),
    pe_ttm: decimalString.nullable(),
    pe_dynamic: decimalString.nullable(),
    pb: decimalString.nullable(),
    peg: decimalString.nullable(),
    gross_margin_ttm: decimalString.nullable(),
  }).strict(),
}).strict();
```

调用方：前端 E-1 list 走 `useStockSnapshots(codes)`，sectors 视图按当前选中 sector 的 codes 拉一次。
`StockSnapshotDto` **不**写回 parquet，也**不**进 sectors / blacklist / 筛选 evidence —— 它仅是 list 视图的渲染口径。
sector 评估器（screening）继续读 `StockMetaDto` 原始结构 + kline，不走该 DTO，避免比率参与筛选时跨进程口径漂移。

### 6.4 Arrow Flight RPC

NestJS adapter 通过 Flight 调用 Python：

| Op | 入参 | 出参 schema |
|---|---|---|
| `get_stock_meta_batch` | `{ codes: string[] }` | `STOCK_META_SCHEMA`（按输入顺序，缺失丢弃） |
| `list_stock_meta_by_industry` | `{ sw_l2: string }` | 同上（按 code 排序） |
| `list_stock_meta_all` | `{}` | 同上（按 code 排序） |
| `list_stock_snapshots` | `{ codes: string[] }` | `STOCK_SNAPSHOT_SCHEMA`（meta 字段 + price + 派生字段；按输入顺序） |

业务端的 `getOne(code)` 复用 `get_stock_meta_batch([code])`，单条结果空 → 控制器层抛 `STOCK_NOT_FOUND`。
`list_stock_snapshots` 在 Python 侧组装：取 `StockMeta` + `KlineRepo.get_latest_close(code)` + 调 `derive_metrics(meta, price)`，零跨进程往返。

## 7. 性能预算

| 操作 | 预算 | 备注 |
|---|---|---|
| `get(code)` | < 5ms | 单次 parquet read + filter |
| `list_all()` | < 50ms | 5500 行整文件读 + 排序 |
| `list_stock_snapshots(codes ≤ 50)` | < 80ms | meta read + kline last-close lookup + 7 个派生公式 |
| `fetch_all()`（一次 AKShare 拉全量） | < 15s | 实测 ~ 8.7s |
| `fetch_one(code)`（XQ 单股） | < 500ms | 实测 180-440ms |
| `stock_yjbb_em(quarter)`（bulk 季报） | < 3s | 实测 1.2-2.1s |
| 8 季度财报 bulk 抓取 | < 25s | 串行 8 RTT，cron 单次开销 |
| 全量增强（5500 × `fetch_one`） | 15-25 min | 串行；NestJS 队列分散到多个 cron 窗口 |
| 财报慢补齐（5500 × ths + em） | 30-50 min | 同样走队列分散 |

## 8. 测试要求

### 8.1 unit（核心资产，零 mock）

- `name_to_pinyin_initials`：常见名 / 含 `*ST` / 含数字 / 空字符串
- `_exchange_for_code` 前缀映射：`60xxxx → SH`、`688xxx → SH`、`920xxx → BJ`（关键回归 — 早期实现把 9 开头一律归 SH 漏掉了 BJ 的 920 前缀）
- `_basic_row_to_meta` / `_xq_fields_to_meta`：字段缺失、`nan` 字符串、不合法 code
- **`derive_metrics`（每个公式分别一组用例）**：
  - golden path（全字段齐 → 出值正确，含动态 PE 的季度年化系数 `4 / quarter_index`）
  - 任一分母 ≤ 0 → `None`
  - quarterlies 不足 4 / 不足 8 → `pe_ttm` / `peg` / `gross_margin_ttm` 分别按缺什么返 `None`
  - 跨年边界（quarterlies 横跨 12-31 / 03-31）的 PEG 同比口径正确
  - `Decimal` 精度回归：`mkt_cap = 50.05 × 8_134_600_000` 不丢精度

### 8.2 integration

- `ParquetStockMetaRepo` 全流程：upsert → get → list_by_industry → list_all
- `AKShareStockMetaSource` + 注入 fake gateway：测试 `fetch_all` / `fetch_one` 的两条主路径，**不依赖外网**

### 8.3 contract

- Arrow Flight：`get_stock_meta_batch` / `list_stock_meta_by_industry` / `list_stock_meta_all` 三个 op 的 schema 与 Python 侧 `STOCK_META_SCHEMA` 严格匹配
- HTTP：spawn 真实 Python Flight server + Nest app + supertest，跑全部 4 条 HTTP 路由

## 9. 风险与备注

- AKShare 来自爬虫，schema 可能变；`_iter_rows` 同时接受 pandas DataFrame 与 list[dict]，新字段会被忽略（保守降级）
- `industries` 字段口径不稳：XQ 给一级行业；后续如接入提供申万二/三级口径的源，需要决定**主源切换时是否强制全量重新增强**（默认不强制 — `industries` 缺失 → 编排层自动补，无须人工干预）
- pypinyin 对生僻字偶有误判（多音字取常见读法）；UI 显示拼音首字母仅作搜索辅助，不参与业务判定
- **动态 PE 口径**钉死为 EastMoney 风格（`latest_quarter.net_profit × 4 / quarter_index`）。其它常见口径——例如年报推全年、机构一致预期——结果会偏，且季度切换时的跳跃明显。任何想换口径的需求都要先改这条 §2.1 的公式条目并配契约测试，不允许在 derive 层 inline 切换。
- **`stock_yjbb_em` 字段错位**：EM 偶发把"营业收入-同比"写到"营业收入"列。抓取器要做合理性校验（数值在 [-1, 100] 范围视为同比、否则视为绝对值），失败则丢该行而非污染本地 cache
- **PEG 在亏损/微利股上数值无意义**：分母 ≤ 0 时强制返 `None`，UI 渲染 `—`；不要让"负 PEG"出现在排序中导致全表错乱

## 10. 待增强

本模块的延伸方向（schema 扩展、二级索引、搜索能力等）集中在 `docs/todo-enhancement.md` 的 "stock-meta" 段，避免本文件长期堆积"待办式"内容。落地某条增强前，先在 `todo-enhancement.md` 给它写明触发条件、迁移步骤、影响面。
