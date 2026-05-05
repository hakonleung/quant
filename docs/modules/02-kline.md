# K-line — 日线行情

## 功能

- 日线 OHLCV + 复权因子 + 预计算技术指标（MA5/10/20/60）。
- 增量更新：按交易日水位只补缺失区间。
- 给筛选 / 形态 / 图表统一供数。

## 实现

| 层 | 位置 | 说明 |
| -- | ---- | ---- |
| Source | `quant_io/sources/akshare_kline.py` | 单代码 / 区间拉取，自动重试 |
| Repo | `quant_cache/parquet_kline_repo.py` | 一股一文件 Parquet，DuckDB 读取（列裁剪 + 谓词下推） |
| Service | `quant_core/services/kline_service.py` | 读 / 写 / 水位查询，封装前复权计算与 MA 预计算 |
| RPC | `quant_rpc/ops/kline.py`（同步）+ `kline_read.py`（读取） | Arrow Flight 双向 |
| API | `apps/api/src/modules/kline/` | `GET /kline/:code?range=…` |
| Web | `feat-eq-chart`、`feat-eq-list` | lightweight-charts K 线图 + 列表 |
| Worker | `apps/api/src/modules/orchestration/kline-worker.ts` | 入队批量同步 |

## 落库规约

落库时**预计算**并写入：
- 前复权价 `open_qfq / high_qfq / low_qfq / close_qfq`
- 基于前复权 close 的 `ma5 / ma10 / ma20 / ma60`

下游（screen / pattern）一律读 qfq 列，禁止再算一次。

## 缓存策略

- **路径**：`data/kline/<code>.parquet`（单股一个文件，便于并发 / 部分备份）。
- **写入**：`tempfile + os.replace` + `FileLock(<code>.lock)`，读端无锁。
- **增量**：`KlineService.watermark(code)` 返回最新交易日；同步只拉 `(watermark, today]`。
- **读取**：DuckDB 直读 Parquet，按需选列（`SELECT trade_date, close_qfq, ma20 …`）。
- **schema 演进**：Parquet metadata 含 `schema_version`，不匹配触发整文件重建（在 `kline_schema.py` 定义）。
