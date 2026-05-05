# Stock Meta — 股票元信息

## 功能

- 维护 A 股股票的基础信息：代码、名称、拼音、交易所、行业、上市日期、退市状态等。
- 为筛选 / 看板 / K 线模块提供"股票宇宙"基线（如剔除 ST、北交所、退市）。
- 支持中文名 / 拼音模糊搜索。

## 实现

| 层 | 位置 | 说明 |
| -- | ---- | ---- |
| Source | `services/py/quant_io/sources/akshare_stock_meta.py` | akshare 拉取沪深主板 + 创业板 + 科创板 + 北交所列表 |
| Repo | `services/py/quant_cache/parquet_stock_meta_repo.py` | 单文件 Parquet 全表存储 |
| Service | `services/py/quant_core/services/stock_meta_service.py` | 查询 / 过滤 / 拼音匹配 |
| Sync | `services/py/quant_core/services/stock_meta_sync_service.py` | 拉取最新 + 全量替换 + 拼音回填（pypinyin） |
| RPC | `services/py/quant_rpc/ops/stock_meta.py`、`stock_meta_admin.py` | Arrow Flight 查询 / 触发同步 |
| API | `apps/api/src/modules/stock-meta/` | `GET /stock-meta`、`POST /stock-meta/sync` |
| Web | `feat-sec-list` | 全宇宙搜索 / 表格 |

## 缓存策略

- **存储**：`data/meta/stocks.parquet`（约 5500 行）。
- **更新**：手动触发或 cron 每日盘后；写入走 `tempfile + os.replace` 原子替换 + `FileLock`。
- **读取**：内存缓存（首次加载 polars DataFrame，后续命中复用）；外部触发 sync 后失效重载。
- **校验**：schema 版本写入 Parquet metadata，启动时不匹配则报 `META_STALE`。
