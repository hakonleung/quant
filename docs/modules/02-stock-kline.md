# 模块 02 — 股票日线数据（stock-kline）

## 1. 职责

维护本地全市场 A 股日线数据。**入库时预计算前复权价与均线**，所有下游模块（筛选、形态、可视化）默认使用前复权列。同步触发由编排层（`docs/modules/09-update-orchestration.md`）统一调度 —— 本模块只暴露纯计算 + 仓储能力。

## 1.1 数据起点（硬约束）

**全市场日线最早起点固定为北京时间 `2024-09-20`**（含当日）。理由：

- 2024-09-24 起 A 股进入新一轮政策驱动行情，前期数据对当前形态匹配/筛选噪声大于信号
- 数据量从全部历史压缩到 ~ 1.5 年，单股 ~ 350 行，全市场 ~ 200 万行，本机 Parquet 完全可承载
- 起点固定后 `compute_qfq_prices` 的复权基准更稳定 —— 复权因子表只覆盖该窗口，不必再回溯 N 年股权变动

实现位置：`quant_core/domain/types/kline.py` 的模块级常量

```python
KLINE_FLOOR_DATE: Final[date] = date(2024, 9, 20)   # Asia/Shanghai
```

所有 `fetch_range` / `compute_qfq_prices` / 同步策略一律以 `max(KLINE_FLOOR_DATE, list_date)` 为下界。修改这个常量需要走 RFC（影响 5.x 全量回算与所有缓存文件）。

## 2. 核心实体

```python
# services/py/quant_core/domain/types/kline.py
@dataclass(frozen=True, slots=True)
class DailyBar:
    code: str
    trade_date: date
    # 原始（不复权）
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int                 # 股
    amount: Decimal             # 元
    turnover_rate: Decimal      # 小数（0.05 = 5%）
    # 前复权（落库时计算）
    open_qfq: Decimal
    high_qfq: Decimal
    low_qfq: Decimal
    close_qfq: Decimal
    # 基于 close_qfq 的均线（落库时计算）
    ma5:  Decimal | None
    ma10: Decimal | None
    ma20: Decimal | None
    ma60: Decimal | None
    # 衍生
    pct_chg_qfq: Decimal | None  # (close_qfq - prev_close_qfq) / prev_close_qfq
    adj_factor: Decimal          # 用于追溯复权计算
```

不变量（contract test 强制）：

- 任意 `bar`：`low <= open <= high`、`low <= close <= high`、对应 qfq 字段同样成立
- 同一 `code` 的 `adj_factor` 单调（从最早日 = 某基准到最新日 = 1.0）
- `ma5` 在 `code` 的前 4 个交易日为 `None`，第 5 个交易日开始有值；`ma10/20/60` 类推

## 3. 端口与适配器

```python
# ports/kline_source.py
class KlineSource(Protocol):
    def fetch_range(self, code: str, start: date, end: date) -> Iterable[RawDailyBar]: ...
    def fetch_adj_factors(self, code: str, start: date, end: date) -> Iterable[AdjFactor]: ...

# ports/kline_repo.py
class KlineRepo(Protocol):
    def upsert_bars(self, code: str, bars: Iterable[DailyBar]) -> None: ...
    def get_range(self, code: str, start: date, end: date, columns: Sequence[str] | None) -> pa.Table: ...
    def get_last_bar(self, code: str) -> DailyBar | None: ...
    def get_universe_slice(
        self, codes: Sequence[str], start: date, end: date, columns: Sequence[str] | None
    ) -> pa.Table: ...
```

`get_*` 返回 **Arrow Table**（不是 dataclass list），便于零拷贝传给 Polars / DuckDB / Arrow Flight。

**与通用缓存端口的关系**：`KlineRepo` 是业务接口；其默认实现 `ParquetKlineRepo` 内部委托给 `TimeSeriesStore`（见 `docs/integrations/cache-abstraction.md` §10）。业务层只 import `KlineRepo`，不感知底层存储。

## 4. 缓存布局

按 `code` 分区的 Parquet（每只股票一个文件，便于增量与并发写）：

```
data/kline/
├── daily/
│   ├── 600519.parquet            # 文件名 = 裸 6 位 code，无交易所后缀
│   ├── 000001.parquet
│   └── ...
├── _state/
│   ├── kline.json                # { last_full_sync, by_code: { code: { last_date, last_adj_factor }}}
│   └── dead_letter.parquet       # 失败任务死信
└── _index/
    └── duckdb.db                 # DuckDB 索引：(code, date) -> file path，加速 get_universe_slice
```

> 与 `docs/modules/01-stock-meta.md` 一致，文件名采用裸 6 位 code（`600519.parquet` 而非 `600519.SH.parquet`）。SH/SZ/BJ 三地代码不重叠，无需后缀消歧。

**为什么按 code 分区**：

- A 股股票数 ~5500，文件数可控
- 增量更新只追加最新行，避免重写大文件
- 除权日只重算单只股票
- 并发拉取友好

**为什么也建 DuckDB 索引**：跨股票切片（筛选场景）一次 SQL 比 5500 次小文件 IO 快。DuckDB 直接读 Parquet（外部表），无需双写。

## 5. 入库时的预计算（关键）

每次写入 `bars` 前，pure 函数完成：

```python
# domain/rules/qfq.py
def compute_qfq_prices(bars: list[RawDailyBar], adj_factors: list[AdjFactor]) -> list[DailyBar]:
    """
    前复权计算：
    qfq_price[t] = raw_price[t] * adj_factor[t] / adj_factor[latest]
    其中 adj_factor[latest] 是当前最新日的复权因子（基准）。
    """

# domain/rules/ma.py
def compute_ma(close_qfq: Sequence[Decimal], window: int) -> Sequence[Decimal | None]:
    """简单移动平均，前 window-1 个值返回 None。"""
```

均线 `ma5/10/20/60` 都基于 `close_qfq`，调用同一个 `compute_ma`，参数不同。

### 5.1 除权除息日的全量回算

新增一行 `adj_factor` 变化时（除权除息发生），**该股票全部历史**的 qfq 价 + 全部 MA 都要重算。流程：

```
1. 读该股票全部 raw bars + 全部 adj_factors
2. 调 compute_qfq_prices（纯函数）
3. 调 compute_ma × 4
4. 原子替换该股票 parquet 文件（写 .tmp 再 rename）
5. 更新 _state.by_code[code].last_adj_factor
6. 标记 DuckDB 索引失效（下次查询时刷新该 code 的元数据）
```

**纯函数 + 单文件覆写 = 失败可重入**。

## 6. 更新策略

**调度入口在 NestJS（`docs/modules/09-update-orchestration.md`）**：cron 触发 + API 读时按需触发。本节描述每个更新单元（per-code）的 Python 侧语义。

### 6.1 全量回填（新股票首次入库 / 状态空）

- 拉取 `[max(KLINE_FLOOR_DATE, list_date), today]` 的 raw bars + adj_factors
- 一次性 compute_qfq + compute_ma
- 写入；`_state.by_code[code].last_date = bars[-1].date`

### 6.2 增量更新（最新交易日补齐）

1. 读 `_state.by_code[code].last_date`（缺失视为 `KLINE_FLOOR_DATE - 1`）
2. 拉取 `(last_date, today]` 的 raw bars（区间下界永远裁到 `KLINE_FLOOR_DATE`）
3. 拉取同区间的 adj_factor
4. **检查 adj_factor 是否变化**：
   - 变化 → 该股票走 6.1 全量回算
   - 未变化 → 仅 append 新行；新增行的 MA 用既有最后 60 行 close_qfq + 新行计算
5. upsert + 更新 `_state.by_code[code].last_date`

`last_date` < 最新交易日（按 `domain/rules/calendar.py` 派生）即视为"陈旧"，编排层据此把 code 加入 kline 更新队列。

### 6.3 错误恢复

详见 `rfcs/0002-incremental-update-recovery.md`。要点：

- 每只股票一个独立任务，单只失败不阻塞其它
- 失败任务进 `dead_letter.parquet`，下次调度重跑
- 死信连续失败 ≥ 3 次 → 触发 `docs/modules/08-notifications.md` 告警，等人工介入

## 7. 查询接口

### 7.1 Python public API

```python
class KlineService:
    def get_range(
        self, code: str, start: date, end: date, *, columns: Sequence[str] | None = None
    ) -> pa.Table: ...
    def get_universe_slice(
        self, codes: Sequence[str], start: date, end: date, *, columns: Sequence[str] | None = None
    ) -> pa.Table: ...
    def get_last_n(self, code: str, n: int) -> pa.Table: ...
```

`columns` 必传时只读这些列（列裁剪，省内存）。默认 `None` 返回全部列。

### 7.2 NestJS HTTP API

| Method | Path               | Query                                       | Response                                           |
| ------ | ------------------ | ------------------------------------------- | -------------------------------------------------- |
| GET    | `/api/kline/:code` | `?start=...&end=...&columns=close_qfq,ma20` | JSON 数组（< 5000 行）或 Arrow Stream（> 5000 行） |

### 7.3 Arrow Flight RPC

筛选/形态等批量场景必走：

```
GetKlineUniverse(codes: string[], start: date, end: date, columns: string[]) -> Arrow Stream
```

## 8. 性能预算

| 操作                                                      | 预算            |
| --------------------------------------------------------- | --------------- |
| `get_range` 单只 1 年                                     | < 20ms          |
| `get_universe_slice` 全市场 30 日，仅 close_qfq + ma20 列 | < 500ms         |
| 单只全量回算（10 年数据）                                 | < 200ms         |
| 单只增量（1 天）                                          | < 5ms           |
| 全市场增量同步                                            | < 5min（含 IO） |

## 9. 测试要求

### 9.1 unit（核心资产，零 mock）

- `compute_qfq_prices`：金价区间、单除权日、多除权日、首日、空数据、负价格（应 raise）
- `compute_ma`：window > len、window = 1、空、含 None、Decimal 精度
- 不变量（property）：复权后任意两点比值 = 复权前同两点比值（数学性质）

### 9.2 integration

- `ParquetKlineRepo` 全流程：上市 → 增量 → 除权回算 → 查询
- DuckDB 索引：`get_universe_slice` 的 SQL 计划走索引（用 `EXPLAIN`）

### 9.3 contract

- Arrow Schema 双向：写 Arrow Table → 读出，类型与值不变（含 Decimal 精度）

## 10. 风险与备注

- 不同源的 `adj_factor` 算法可能略有差异；切源 = 全量重算
- A 股有"特殊停牌"导致连续多日无 bar，MA 仍按"已发生交易日"窗口算（不补 0）
- 极端涨停板可能成交量为 0，`turnover_rate = 0`；但仍是有效 bar
- Decimal 精度（写入前用 `domain/pure/decimal.py:quantize_*` 统一）：
  - 价格 (`open/high/low/close` 及 `*_qfq` / `ma*`)：4 位小数
  - 成交量 `volume`：0 位（整数股）
  - 成交额 `amount`：2 位（元）
  - 换手率 `turnover_rate`、涨跌幅 `pct_chg_qfq`：6 位（足够表达万分之一）
  - **复权因子 `adj_factor`：4 位小数**
