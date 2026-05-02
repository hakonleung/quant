# 模块 05 — 新闻和研报（news-research）

## 1. 职责

维护本地新闻库和研报库（按股票打标），增量拉取，提供 (code, date_range) 查询接口。

**不做内容分析**——分析在模块 06。本模块只负责"取下来 + 存好 + 取得到"。

## 2. 核心实体

```python
# domain/types/news.py
@dataclass(frozen=True, slots=True)
class NewsItem:
    id: str                     # source_id @ source，全局唯一
    source: NewsSource          # tushare | akshare | custom
    title: str
    summary: str | None         # 来源给的摘要；可能为 None
    body: str | None            # 正文（可能很长，按 source 决定）
    url: str
    published_at: datetime      # UTC
    related_codes: tuple[str, ...]  # 来源标注的相关股票
    related_industries: tuple[str, ...]  # SW 行业代码
    fetched_at: datetime

@dataclass(frozen=True, slots=True)
class ResearchReport:
    id: str
    source: ReportSource        # tushare | broker_a | ...
    broker: str                 # 券商名
    title: str
    target_code: str            # 主标的
    rating: str | None          # 评级（"买入"/"增持"/...）
    target_price: Decimal | None
    pdf_url: str | None
    pdf_local_path: str | None  # 已下载则有
    summary: str | None
    published_at: datetime
    fetched_at: datetime
```

## 3. 端口与适配器

```python
# ports/news_source.py
class NewsSource(Protocol):
    def fetch_since(self, since: datetime) -> Iterable[NewsItem]: ...
    def fetch_for_code(self, code: str, since: datetime, until: datetime) -> Iterable[NewsItem]: ...

# ports/report_source.py
class ReportSource(Protocol):
    def fetch_since(self, since: datetime) -> Iterable[ResearchReport]: ...
    def fetch_pdf(self, report_id: str) -> bytes: ...

# ports/news_repo.py
class NewsRepo(Protocol):
    def upsert_many(self, items: Iterable[NewsItem]) -> None: ...
    def query(self, code: str, start: datetime, end: datetime) -> list[NewsItem]: ...
    def query_by_industry(self, sw_code: str, start: datetime, end: datetime) -> list[NewsItem]: ...
```

v1 适配器：

- `TushareNewsSource`、`AKShareNewsSource`（兜底）
- `TushareReportSource`
- `ParquetNewsRepo`、`ParquetReportRepo` + `FilesystemPdfStore`（PDF 落本地 `data/reports/pdf/`）

**与通用缓存端口的关系**：`NewsRepo` / `ReportRepo` 是业务接口，默认实现内部委托给通用 `TimeSeriesStore` / `RecordRepo`（见 `docs/integrations/cache-abstraction.md` §10）。换底层存储只改 adapter，不动业务接口。

## 4. 缓存布局

```
data/news/
├── by_month/
│   ├── 2026-05.parquet         # 当月全部新闻
│   ├── 2026-04.parquet
│   └── ...
├── _index/
│   └── duckdb.db               # (id) 主键 + (code, published_at) 二级索引
└── _state/
    ├── news.json               # 各源 last_published_at
    └── dead_letter.parquet

data/reports/
├── meta/
│   └── 2026.parquet            # 当年研报元数据
├── pdf/
│   └── <id>.pdf
└── _state/
    └── reports.json
```

**为什么按月分区新闻**：新闻量大（日均数千条），按月切控制单文件大小，月内查询用 DuckDB 直接 scan 即可。

**为什么 DuckDB 索引**：跨月 + 按 code 过滤的查询非常常见，让 DuckDB 维护索引，写入新数据后增量刷新。

**多对多关系**：一条新闻可能关联多只股票。Parquet 中用 `related_codes` list 列存；DuckDB 索引用 unnest + 二级表。

## 5. 更新策略

### 5.1 增量拉取

- 调度：每天 4 次（盘前 8:30、午盘 12:00、盘后 16:00、夜间 20:00）
- 流程：从 `_state.last_published_at` 起拉取增量 → upsert → 更新 state
- 去重：以 `id` 为主键，重复 upsert 安全
- 失败：进死信队列；详见 `rfcs/0002-incremental-update-recovery.md`

### 5.2 PDF 下载（研报）

- v1 默认**不**自动下载 PDF（占空间且很多源限速），仅存 `pdf_url`
- 用户在 UI 触发"下载"时按需取，存 `data/reports/pdf/<id>.pdf` + 更新 `pdf_local_path`
- 下载有限流（每分钟 ≤ 30 个 PDF），并发 ≤ 3

## 6. 查询接口

### 6.1 Python public API

```python
class NewsService:
    def for_stock(self, code: str, days: int = 30, *, asof: date | None = None) -> list[NewsItem]: ...
    def for_industry(self, sw_l2: str, days: int = 30) -> list[NewsItem]: ...
    def for_codes(self, codes: Sequence[str], days: int = 30) -> dict[str, list[NewsItem]]: ...

class ReportService:
    def for_stock(self, code: str, days: int = 90) -> list[ResearchReport]: ...
    def latest_consensus(self, code: str) -> ConsensusSummary: ...   # 多券商评级聚合（v2）
```

### 6.2 NestJS HTTP API

| Method | Path                          | Query      | Response              |
| ------ | ----------------------------- | ---------- | --------------------- |
| GET    | `/api/news/:code`             | `?days=30` | `NewsItemDto[]`       |
| GET    | `/api/news/industry/:sw_code` | `?days=30` | `NewsItemDto[]`       |
| GET    | `/api/reports/:code`          | `?days=90` | `ResearchReportDto[]` |
| POST   | `/api/reports/:id/download`   | —          | `{ local_path }`      |

### 6.3 Arrow Flight RPC

仅当批量（≥ 50 只股票）时使用：`GetNewsForCodesBatch`、`GetReportsForCodesBatch`。

## 7. 性能预算

| 操作                        | 预算                         |
| --------------------------- | ---------------------------- |
| `for_stock(code, 30d)`      | < 50ms                       |
| `for_codes(50 stocks, 30d)` | < 300ms（DuckDB SQL 一次性） |
| 增量拉取（一次）            | < 60s                        |

## 8. 测试要求

### 8.1 unit

- 去重逻辑：相同 id 上传两次，只存一次
- 时间窗口边界：`since < t < until`（左开右开 / 左闭右开 由约定决定，必须在测试中明确并固化）

### 8.2 integration

- 拉取 → 入库 → 查询完整链路（用真实 ParquetNewsRepo + tmp 路径）
- DuckDB 索引：upsert 后 query 命中索引（EXPLAIN 验证）

### 8.3 contract

- 来源 schema 变化检测：每次调 source 后验证 zod / pydantic 通过；schema 变化在 CI 中显式标红

## 9. 风险与备注

- **来源不稳定**：tushare news 接口偶尔 schema 变化、字段缺失——所有字段都允许 `None`，但 `id`/`title`/`published_at`/`source` 必须存在，否则丢弃 + 死信
- **关联股票打标质量**：来源给的 `related_codes` 不一定准。v1 信任来源；v2 可加自定义 NER 二次标注
- **PDF 解析**：v1 不解析正文。v2 用 `unstructured` 或类似库
- **舆论合规**：避免存储/转发明显违规内容；本项目仅取公开信息源，不爬非公开页面
