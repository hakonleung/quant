# 模块 01 — 股票基础信息（stock-meta）

## 1. 职责

维护本地全市场 A 股股票的元信息，对外提供查询接口，并在缓存命中不全时按需触发更新（详见 `docs/modules/09-update-orchestration.md`）。

**不负责**：日线行情、新闻、研报、价格驱动分析。

## 2. 核心实体

```python
# services/py/quant_core/domain/types/stock.py
@dataclass(frozen=True, slots=True)
class StockMeta:
    code: str            # 裸 6 位字符串，如 "600519"
    name: str            # "贵州茅台"
    name_pinyin: str     # "GZMT"，由 pypinyin 离线生成（首字母大写）
    industries: str      # 逗号拼接，由粗到细，如 "食品饮料,白酒"；可能为空
    list_date: date      # 上市日（北京时区，存为 date）
    float_pct: Decimal   # 流通股 / 总股本，区间 [0, 1]，缺省值 Decimal(1)
    updated_at: datetime # 本地缓存写入时间，UTC
```

设计取舍（与早期版本的对比）：

- **不存 `exchange`**：A 股 6 位代码空间在 SH/SZ/BJ 三地不重叠，必要时下游按前缀派生。前缀映射逻辑只在数据源 adapter 内部存在（用于构造 `ak.stock_individual_basic_info_xq` 所需的 `SH600519` 形式 symbol），**不写回缓存行**。
- **不存 `board` / `delist_date` / `status`**：`board` 同样可以从 code 前缀派生；缓存只保留**当前上市**股票（数据源以 `list_status="L"` 过滤），退市的下次同步直接掉行，不翻 flag。
- **`float_pct` 取代 `total_share` + `float_share`**：业务代码消费的是比率（例如换手率、市值因子的标度），原始两列一律会派生比率；存比率本身能避开股票拆分对绝对股本的扰动，且 Decimal(1) 默认对未提供该字段的来源（如 AKShare 大列表）天然兼容。
- **`industries` 是单字符串**：申万一/二/三级口径在不同源之间不一致；XQ 仅给出**一级行业名**（无三级层次）；统一拍平为 "粗到细" 的逗号串，UI 直接展示，需要查询时用 `LIKE` / `contains`。
- **`code` 是裸 6 位**：对 NL 输入、URL path、key-value 查询都最友好；无需在前端再做 `600519.SH` ↔ `600519` 的双向转换。

TS 侧：`packages/shared/src/types/stock-meta.ts` 直接手写（不在 `proto/` 单一源里），字段、正则、零拷贝由 `StockMetaDtoSchema` 强约束 —— 6 位数字 / `YYYY-MM-DD` / 带时区 ISO8601 / 十进制字符串。

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

### 3.1 AKShareStockMetaSource — 双端点策略

| 上游 | 用途 | 调用频率 |
|---|---|---|
| `ak.stock_info_a_code_name()` | 全量 code+name 列表（5500+ 行 ~ 10s） | `fetch_all()` 每次 |
| `ak.stock_individual_basic_info_xq(symbol)` | 单股扩展信息（`affiliate_industry`、`listed_date`、`org_short_name_cn`） | `fetch_one(code)` 每次（180-440ms / call） |

`fetch_all` 只走第一个端点，得到部分字段：`code`、`name`、`name_pinyin`、`updated_at` 真实；`industries=""`、`list_date=1990-01-01`（哨兵值）、`float_pct=Decimal(1)` 占位。需要完整字段时由编排层（NestJS 队列）按 code 调用 `fetch_one` 做补齐。

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

**列表**（与 `STOCK_META_SCHEMA` 一一对应）：`code` (string) / `name` (string) / `name_pinyin` (string) / `industries` (string) / `list_date` (date32) / `float_pct` (string Decimal) / `updated_at` (timestamp[us, UTC])。

历史快照（`_history/`）当前**不**写；如需要回溯研究再通过 RFC 引入。

## 5. 同步策略

每条行的"完整度"由两位组成：

- **基础位**（来自 `fetch_all`）：`code` + `name` 必填；`industries=""` 视为缺失。
- **增强位**（来自 `fetch_one`）：`industries != ""` 视为已增强。

### 5.1 全量同步（base sync）

- 触发：首次启动 / `meta.last_full_sync` 距今 > 7 天 / 手动 CLI（`uv run python -m quant_io.sync stock-meta --full`）
- 流程：`AKShareStockMetaSource.fetch_all()` → `repo.upsert_many(...)` → 写 state
- 失败：保留旧文件（parquet 的原子 rename 保证一致性），记录到 source health

### 5.2 增量增强（per-code enrich）

- 触发：编排层（NestJS）发现某 code 的 `industries == ""` 或行不存在；详见 `docs/modules/09-update-orchestration.md` §3
- 流程：`source.fetch_one(code)` → 与本地行 merge（XQ 字段优先）→ `repo.upsert_many([merged])`
- 失败：保留旧行；该 code 下次窗口再尝试

### 5.3 数据源 fallback

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

| Method | Path                        | Query             | 200 Response     |
| ------ | --------------------------- | ----------------- | ---------------- |
| GET    | `/api/stocks`               | —                 | `StockMetaDto[]` |
| GET    | `/api/stocks/batch`         | `?codes=a,b,c`    | `StockMetaDto[]` |
| GET    | `/api/stocks/by-industry`   | `?sw_l2=...`      | `StockMetaDto[]` |
| GET    | `/api/stocks/:code`         | —                 | `StockMetaDto`   |

> 路由顺序在 controller 中**字面段先于 `:code` 通配**，否则 `/api/stocks/batch` 会被 `:code` 吞掉。

错误：`STOCK_NOT_FOUND` (404) / `INVALID_ARGUMENT` (400) / `INTERNAL` (500)。`META_STALE` (503) 当前未实现 —— 编排层默认提供"读时补齐"语义，缓存空了直接返 200 加触发后台填充。

### 6.3 Arrow Flight RPC

NestJS adapter 通过 Flight 调用 Python：

| Op | 入参 | 出参 schema |
|---|---|---|
| `get_stock_meta_batch` | `{ codes: string[] }` | `STOCK_META_SCHEMA`（按输入顺序，缺失丢弃） |
| `list_stock_meta_by_industry` | `{ sw_l2: string }` | 同上（按 code 排序） |
| `list_stock_meta_all` | `{}` | 同上（按 code 排序） |

业务端的 `getOne(code)` 复用 `get_stock_meta_batch([code])`，单条结果空 → 控制器层抛 `STOCK_NOT_FOUND`。

## 7. 性能预算

| 操作 | 预算 | 备注 |
|---|---|---|
| `get(code)` | < 5ms | 单次 parquet read + filter |
| `list_all()` | < 50ms | 5500 行整文件读 + 排序 |
| `fetch_all()`（一次 AKShare 拉全量） | < 15s | 实测 ~ 8.7s |
| `fetch_one(code)`（XQ 单股） | < 500ms | 实测 180-440ms |
| 全量增强（5500 × `fetch_one`） | 15-25 min | 串行；NestJS 队列分散到多个 cron 窗口 |

## 8. 测试要求

### 8.1 unit（核心资产，零 mock）

- `name_to_pinyin_initials`：常见名 / 含 `*ST` / 含数字 / 空字符串
- `_exchange_for_code` 前缀映射：`60xxxx → SH`、`688xxx → SH`、`920xxx → BJ`（关键回归 — 早期实现把 9 开头一律归 SH 漏掉了 BJ 的 920 前缀）
- `_basic_row_to_meta` / `_xq_fields_to_meta`：字段缺失、`nan` 字符串、不合法 code

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

## 10. 待增强

本模块的延伸方向（schema 扩展、二级索引、搜索能力等）集中在 `docs/todo-enhancement.md` 的 "stock-meta" 段，避免本文件长期堆积"待办式"内容。落地某条增强前，先在 `todo-enhancement.md` 给它写明触发条件、迁移步骤、影响面。
