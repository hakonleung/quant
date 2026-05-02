# 集成 — 缓存抽象（cache-abstraction）

## 1. 目标

让所有数据消费方（meta、kline、news、reports 等）通过**统一端口**访问本地数据，底层实现可插拔。v1 默认 Parquet 文件 + DuckDB 索引；未来可切换 SQLite / PostgreSQL / Redis / S3。

## 2. 端口设计

不存在"通用 KV cache"——量化数据天然结构化。我们按**数据形态**抽象出 3 类端口：

### 2.1 `KeyValueStore`（控制面元数据）

适用：增量水位、配置、任务状态等小对象。

```python
# ports/kv_store.py
class KeyValueStore(Protocol):
    def get(self, key: str) -> bytes | None: ...
    def put(self, key: str, value: bytes, *, ttl_sec: int | None = None) -> None: ...
    def delete(self, key: str) -> None: ...
    def list_prefix(self, prefix: str) -> Iterable[str]: ...
```

适配器：

- `FileKeyValueStore`（v1 默认）：JSON 文件夹下每 key 一个文件
- `RedisKeyValueStore`（v2）

### 2.2 `RecordRepo[T]`（域对象 CRUD）

适用：StockMeta 这类**有限规模、按主键访问**的数据。

```python
# ports/record_repo.py
class RecordRepo(Protocol, Generic[T_co]):
    def get(self, key: str) -> T_co | None: ...
    def upsert_many(self, items: Iterable[T_co]) -> None: ...
    def delete(self, key: str) -> None: ...
    def query(self, predicate: QuerySpec) -> Iterable[T_co]: ...
```

`QuerySpec` 是项目内的小型查询 DSL（不暴露 SQL），覆盖 `eq / in / range / like` 即可，避免泄漏底层。

适配器：

- `ParquetRecordRepo[T]`（v1）
- `SQLiteRecordRepo[T]`（v2）

### 2.3 `TimeSeriesStore`（大规模时序，列存优先）

适用：KLine、新闻这类**按 (entity, time) 切片的列存数据**。

```python
# ports/timeseries_store.py
class TimeSeriesStore(Protocol):
    def append(self, entity_key: str, table: pa.Table) -> None: ...                     # 追加新行
    def overwrite(self, entity_key: str, table: pa.Table) -> None: ...                  # 整 entity 覆写（除权回算）
    def read(
        self,
        entity_keys: Sequence[str],
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table: ...
    def last_timestamp(self, entity_key: str) -> datetime | None: ...
```

返回 / 接收一律 `pyarrow.Table`，零拷贝传给上层（Polars / Arrow Flight）。

适配器：

- `ParquetTimeSeriesStore`（v1）
- `DuckDBTimeSeriesStore`（v1.5，将索引外置）
- `PostgresTimeSeriesStore`（v2）

## 3. 装配（依赖注入）

每个 Python 服务在启动时（`quant_rpc/main.py`）按配置装配：

```python
def build_kline_repo(cfg: Config) -> TimeSeriesStore:
    match cfg.cache.kline_backend:
        case "parquet":
            return ParquetTimeSeriesStore(root=cfg.cache.root / "kline" / "daily", schema=KLINE_SCHEMA)
        case "duckdb":
            return DuckDBTimeSeriesStore(db_path=cfg.cache.root / "kline" / "duckdb.db", schema=KLINE_SCHEMA)
        case _:
            raise ConfigError(f"unknown kline_backend: {cfg.cache.kline_backend}")
```

业务代码（`KlineService`）只依赖 `TimeSeriesStore` 端口，不知道底层是谁。**不允许**在业务代码里 `if backend == "parquet"`。

## 4. v1 实现细节：ParquetTimeSeriesStore

```
data/<group>/<entity_key>.parquet         # 主数据
data/<group>/_state/<entity_key>.json     # 单实体状态（last_timestamp, schema_version）
data/<group>/_index/duckdb.db             # 跨实体索引（可选，懒构建）
```

- `append`：读旧文件 + concat + 排序 + 原子写（写 `.tmp` 再 rename）
- `overwrite`：直接写 `.tmp` + rename，不读旧
- `read`：
  - 单 entity：直接 `pyarrow.parquet.read_table(filters=[...], columns=[...])`
  - 多 entity：用 DuckDB 一次 SQL（自动并发读多个 parquet）

**为什么单实体一文件不分块**：A 股 10 年日线 ~ 2500 行 × 20 列 < 100KB，单文件操作友好；新闻按月分（实体 = 月），见 `05-news-research.md`。

## 5. v1 实现细节：DuckDB 作为索引层

不是数据存储，是**Parquet 之上的查询加速层**。

```sql
-- _index/duckdb.db 中
CREATE OR REPLACE VIEW kline AS
  SELECT * FROM read_parquet('data/kline/daily/*.parquet', union_by_name = true);

CREATE INDEX IF NOT EXISTS kline_code_date ON kline(code, trade_date);
```

读路径：

```python
con.execute(
    "SELECT close_qfq, ma20 FROM kline WHERE code IN ($codes) AND trade_date BETWEEN $start AND $end"
).fetch_arrow_table()
```

写路径：仍走 ParquetTimeSeriesStore；写完通知 `con.execute("PRAGMA reset_parquet_metadata_cache")`。

## 6. 切换后端的步骤（v2 切 PostgreSQL 为例）

1. 写 `PostgresTimeSeriesStore`，对端口 100% 兼容
2. 写迁移脚本 `scripts/migrate_kline_parquet_to_pg.py`：扫 parquet → 写 PG
3. 配置切：`cache.kline_backend: postgres`，`cache.kline_dsn: ...`
4. 业务代码 0 改动；契约测试集（`tests/contract/timeseries_store_contract.py`）跑通即上线
5. 灰度：先双读对比一周，再下线 parquet

**可移植性的关键不在"未来切"，在"今天的契约测试**——见 §9。

## 7. 错误与异常

```python
class CacheError(QuantError): ...
class CacheKeyNotFound(CacheError): ...
class CacheCorrupted(CacheError): ...
class CacheBackendUnavailable(CacheError): ...
```

业务层只捕获这些抽象异常。具体后端的异常（`pyarrow.ArrowIOError`、`psycopg.Error`）必须在 adapter 内 catch + 转换。

## 8. 配置

`config/settings.py`（pydantic-settings）：

```python
class CacheSettings(BaseSettings):
    root: Path                          # 默认 ./data
    kv_backend: Literal["file", "redis"] = "file"
    record_backend: Literal["parquet", "sqlite"] = "parquet"
    timeseries_backend: Literal["parquet", "duckdb", "postgres"] = "parquet"
    redis_url: AnyUrl | None = None
    postgres_dsn: AnyUrl | None = None
    # 各后端校验：选 redis 必须给 redis_url，否则拒启动
```

## 9. 契约测试

每种端口在 `tests/contract/<port>_contract.py` 定义一组 abstract test case，所有适配器必须继承并通过：

```python
# tests/contract/timeseries_store_contract.py
class TimeSeriesStoreContract:
    @pytest.fixture
    def store(self) -> TimeSeriesStore: raise NotImplementedError

    def test_append_then_read(self, store): ...
    def test_overwrite_replaces_full_history(self, store): ...
    def test_read_columns_subset(self, store): ...
    def test_read_unknown_entity_returns_empty(self, store): ...
    def test_concurrent_appends_consistent(self, store): ...
    # ... 共 ~15 个用例

# tests/cache/parquet/test_parquet_timeseries_contract.py
class TestParquet(TimeSeriesStoreContract):
    @pytest.fixture
    def store(self, tmp_path):
        return ParquetTimeSeriesStore(root=tmp_path, schema=...)
```

新加适配器 = 复制粘贴 + 实现 fixture。**契约测试是后端可移植性的基石**。

## 10. 与领域 Repo 的分层关系

**重要：本文件定义的是"通用缓存端口"（基础设施层），不是业务直接消费的接口。**

业务代码消费的是**领域 Repo**（在各模块文档中定义）：

- `StockMetaRepo`（见 `modules/01-stock-meta.md`）
- `KlineRepo`（见 `modules/02-stock-kline.md`）
- `NewsRepo` / `ReportRepo`（见 `modules/05-news-research.md`）

领域 Repo 暴露**业务语义**的方法（`get_range / get_universe_slice / for_stock / ...`），其默认实现委托给本文件的通用端口：

```
                 业务层 (services/, workflow/)
                          │
                          ▼ depends on
              ┌───────────────────────────────┐
              │  domain Repo (业务接口)        │
              │  KlineRepo / NewsRepo / ...   │
              └───────────────┬───────────────┘
                              │ implemented by
                              ▼
              ┌───────────────────────────────┐
              │  ParquetKlineRepoAdapter      │  ← 这一层做"业务方法 → 通用端口调用"的翻译
              │  ParquetNewsRepoAdapter       │
              └───────────────┬───────────────┘
                              │ uses
                              ▼
              ┌───────────────────────────────┐
              │  通用缓存端口（本文件）         │
              │  TimeSeriesStore / RecordRepo │
              │  / KeyValueStore              │
              └───────────────────────────────┘
```

**为什么两层端口**：

- 领域 Repo 让业务代码读起来像业务（"读这只股票这段时间的 K 线"），且在 mock 时可以零代价替换
- 通用缓存端口让我们换底层存储（Parquet → Postgres）只改 adapter，不动领域 Repo 接口

| 模块领域 Repo           | 默认 adapter                               | 内部使用的通用端口                                        |
| ----------------------- | ------------------------------------------ | --------------------------------------------------------- |
| `StockMetaRepo`         | `ParquetStockMetaRepo`                     | `RecordRepo[StockMeta]` + `KeyValueStore`（state）        |
| `KlineRepo`             | `ParquetKlineRepo`                         | `TimeSeriesStore`（kline） + `KeyValueStore`（watermark） |
| `NewsRepo`              | `ParquetNewsRepo`                          | `TimeSeriesStore`（按月分实体） + `KeyValueStore`         |
| `ReportRepo`            | `ParquetReportRepo` + `FilesystemPdfStore` | `RecordRepo[ResearchReport]` + 文件系统                   |
| `ScreenCacheRepo`       | `KvScreenCacheRepo`                        | `KeyValueStore`                                           |
| `TaskRepo`（sentiment） | `KvTaskRepo`                               | `KeyValueStore`                                           |

**测试约定**：领域 Repo 的契约测试在对应模块（`tests/<module>/test_*_repo_contract.py`）；通用端口的契约测试在本文件 §9。两层独立。

## 11. 性能参考

| 操作                     | Parquet     | DuckDB-on-Parquet | Postgres（预测） |
| ------------------------ | ----------- | ----------------- | ---------------- |
| 单 entity 读 1 年        | 5ms         | 8ms               | 10ms             |
| 100 entity × 30 天，2 列 | 200ms       | 80ms              | 50ms             |
| 单 entity 追加 1 行      | 8ms（重写） | 8ms（重写）       | 1ms              |
| 全市场扫描               | 不适用      | 800ms             | 500ms            |

Parquet 的弱点是"小写多"，但日线场景大多是"日终批量追加"，匹配良好。

## 12. 风险与备注

- Parquet 的并发写需要应用层加锁（同一 entity）；用 `filelock`，每 entity 一锁
- DuckDB 索引文件不进 git；启动时若不存在自动重建
- 切 Postgres 时 Decimal 精度对齐：建表用 `NUMERIC(20, 6)`
