# 模块 01 — 股票基础信息（stock-meta）

## 1. 职责

维护本地全市场 A 股股票的元信息，提供查询接口。

**不负责**：日线行情、新闻、研报。

## 2. 核心实体

```python
# services/py/quant_core/domain/types/stock.py
@dataclass(frozen=True, slots=True)
class StockMeta:
    code: str                    # "600519.SH"
    name: str                    # "贵州茅台"
    name_pinyin: str             # "GZMT"，名称首字母（拼音简码）
    exchange: Literal["SH", "SZ", "BJ"]
    board: Literal["MAIN", "CHINEXT", "STAR", "BSE"]
    industry_sw_l1: str
    industry_sw_l2: str
    industry_sw_l3: str
    list_date: date
    delist_date: date | None
    total_share: Decimal         # 总股本（股）
    float_share: Decimal         # 流通股本（股）
    status: Literal["NORMAL", "ST", "STAR_ST", "SUSPENDED", "DELISTED"]
    updated_at: datetime         # 本地缓存更新时间，UTC
```

TS 侧 zod schema 由 `proto/codegen/` 生成。

## 3. 端口与适配器

```python
# services/py/quant_core/ports/stock_meta_source.py
class StockMetaSource(Protocol):
    def fetch_all(self) -> Iterable[StockMeta]: ...
    def fetch_one(self, code: str) -> StockMeta | None: ...

# services/py/quant_core/ports/stock_meta_repo.py
class StockMetaRepo(Protocol):
    def upsert_many(self, items: Iterable[StockMeta]) -> None: ...
    def get(self, code: str) -> StockMeta | None: ...
    def list_by_industry(self, sw_l2: str) -> list[StockMeta]: ...
    def search_by_name(self, query: str) -> list[StockMeta]: ...   # 支持中文 + 拼音
```

**v1 适配器**：

- `TushareStockMetaSource`（`quant_io/adapters/tushare/`）
- `AKShareStockMetaSource`（兜底，同上）
- `ParquetStockMetaRepo`（`quant_cache/adapters/parquet/`）：单文件 `data/meta/stocks.parquet`，按 `code` 排序便于二分查找

## 4. 缓存布局

```
data/meta/
├── stocks.parquet                  # 当前快照
├── _history/
│   └── stocks_2026-05-01.parquet   # 历史快照（每周一次，便于回溯研究）
└── _state/
    └── meta.json                   # { last_full_sync: "...", last_incremental: "...", source: "tushare" }
```

Parquet schema 用 `proto/schemas/stock_meta.py` 定义（pyarrow.Schema），TS 侧 zod 同源生成。

## 5. 更新策略

### 5.1 全量同步

- 触发：首次启动 / `_state/meta.json.last_full_sync` 距今 > 7 天 / 手动 `/admin/meta/full-sync`
- 流程：`Source.fetch_all()` → 写新 parquet → 原子替换旧文件 → 更新 `_state`
- 失败：保留旧文件，写 `_state.last_error`，记录至死信队列

### 5.2 增量同步

- 触发：每日 18:00（A 股收盘后）
- 流程：拉取当日变更（新上市/退市/股本变更/ST 变更），与本地 diff，仅 upsert 变化项
- 失败处理：详见 `rfcs/0002-incremental-update-recovery.md`

### 5.3 数据源 fallback

- 主源（tushare）失败 → 自动切兜底（akshare）
- 两源都失败 → 不更新本地缓存，告警 + 标记 stale

## 6. 查询接口

### 6.1 Python public API（`quant_core/services/stock_meta_service.py`）

```python
class StockMetaService:
    def __init__(self, repo: StockMetaRepo, clock: Clock) -> None: ...
    def get(self, code: str) -> StockMeta: ...                      # 不存在 → raise StockNotFoundError
    def search(self, query: str, limit: int = 20) -> list[StockMeta]: ...
    def list_by_industry(self, sw_l2: str) -> list[StockMeta]: ...
    def is_stale(self, max_age_hours: int = 24) -> bool: ...
```

### 6.2 NestJS HTTP API

| Method | Path                        | Body / Query      | 200 Response     |
| ------ | --------------------------- | ----------------- | ---------------- |
| GET    | `/api/stocks/:code`         | —                 | `StockMetaDto`   |
| GET    | `/api/stocks/search`        | `?q=...&limit=20` | `StockMetaDto[]` |
| GET    | `/api/stocks/by-industry`   | `?sw_l2=...`      | `StockMetaDto[]` |
| POST   | `/api/admin/meta/full-sync` | —                 | `{ task_id }`    |

错误：`STOCK_NOT_FOUND` (404) / `META_STALE` (503，仅当 source 全失败 + 缓存 > 7 天) / `INTERNAL` (500)。

### 6.3 Arrow Flight RPC

仅当批量获取（>500 条）时使用：

```
GetStockMetaBatch(codes: string[]) -> Arrow Stream of StockMeta
```

## 7. 性能预算

| 操作           | 预算                           |
| -------------- | ------------------------------ |
| `get(code)`    | < 5ms（Parquet 二分 + filter） |
| `search(name)` | < 50ms                         |
| 全量同步       | < 60s（5500 股票）             |
| 增量同步       | < 10s                          |

如全量 parquet 加载慢，改用 DuckDB attach + 索引列。

## 8. 测试要求

- **unit**：纯函数（拼音首字母提取、status 解析、code 格式校验）
- **integration**：`ParquetStockMetaRepo` 用 tmp 路径跑 upsert + query；fallback 链路（mock Source A 抛错，断言切到 Source B）
- **contract**：proto schema 双向：写出再读回，类型保持

## 9. 风险与备注

- tushare 的行业分类口径可能与 akshare 不一致；以**主源**口径为准，切换 source 时强制全量重写一次
- 公司名称可能含特殊字符，写入前必须 strip（`domain/pure/text.py:normalize_company_name`）
- 拼音转换不依赖外部服务（用 `pypinyin` 库，离线）
