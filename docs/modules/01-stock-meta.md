# Stock Meta — 股票元信息

## 功能

- 维护 A 股股票的基础信息：代码、名称、拼音、交易所、行业、上市日期、退市状态等。
- 为筛选 / 看板 / K 线模块提供"股票宇宙"基线（剔除 ST、北交所、退市可选）。
- 支持中文名 / 拼音模糊搜索。

## 实现

| 层      | 位置                                                         | 说明                                                        |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Source  | `services/py/quant_io/sources/akshare_stock_meta.py`         | akshare 拉取沪深主板 + 创业板 + 科创板 + 北交所列表         |
| Repo    | `services/py/quant_cache/parquet_stock_meta_repo.py`         | 单文件 Parquet 全表存储（schema 见 `stock_meta_schema.py`） |
| Service | `services/py/quant_core/services/stock_meta_service.py`      | 查询 / 过滤 / 拼音匹配                                      |
| Sync    | `services/py/quant_core/services/stock_meta_sync_service.py` | 拉取最新 + 全量替换 + 拼音回填（pypinyin）                  |
| RPC     | `services/py/quant_rpc/ops/stock_meta*.py`                   | 见下表                                                      |
| API     | `apps/api/src/modules/stock-meta/`                           | `GET /api/stocks/{code}`（支持批量 `?codes=`）              |
| Web     | `feat-sec-list`                                              | 全宇宙搜索 / 板块（sector）管理                             |

## Flight ops

| op                            | 用途                 |
| ----------------------------- | -------------------- |
| `get_stock_meta_batch`        | 按 code 列表取元信息 |
| `list_stock_meta_by_industry` | 按行业列出           |
| `list_stock_meta_all`         | 全宇宙快照           |
| `check_stock_meta_sources`    | 多源可用性探测       |
| `sync_stock_meta_full`        | 全量从 akshare 刷新  |
| `enrich_stock_meta_for_code`  | 单只补全             |

## 缓存策略

- **存储**：`data/meta/stocks.parquet`（约 5500 行）。
- **更新**：手动触发或 BJT 16:00 cron；写入走 `tempfile + os.replace` 原子替换 + `FileLock`。
- **读取**：内存缓存（首次加载 polars DataFrame，后续命中复用）；外部触发 sync 后失效重载。
- **校验**：schema 版本写入 Parquet metadata，启动时不匹配则报 `META_STALE`。
