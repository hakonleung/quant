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
| Sync    | `services/py/quant_core/services/stock_meta_sync_service.py` | 拉取最新 + 全量覆盖写 + 拼音回填（pypinyin）                |
| RPC     | `services/py/quant_rpc/ops/stock_meta*.py`                   | 见下表                                                      |
| API     | `apps/api/src/modules/stock-meta/`                           | `GET /api/stocks/{code}`（支持批量 `?codes=`）              |
| Web     | `feat-sec-list`                                              | 全宇宙搜索 / 板块（sector）管理                             |

## Flight ops

| op                            | 用途                                          |
| ----------------------------- | --------------------------------------------- |
| `get_stock_meta_batch`        | 按 code 列表取元信息                          |
| `list_stock_meta_by_industry` | 按行业列出                                    |
| `list_stock_meta_all`         | 全宇宙快照                                    |
| `check_stock_meta_sources`    | 多源可用性探测                                |
| `sync_stock_meta_full`        | 全量从 akshare 刷新                           |
| `enrich_stock_meta_for_code`  | 单只补全                                      |
| `list_stock_fund_flow_ranks`  | 全市场 DDE 主力净流入排行（3/5/10/20 日窗口） |

## 缓存策略

- **存储**：`data/meta/stocks.parquet`（约 5500 行）。
- **更新**：手动触发或 BJT 16:00 cron；写入走 `tempfile + os.replace` 原子写 + `FileLock`。
- **读取**：内存缓存（首次加载 polars DataFrame，后续命中复用）；外部触发 sync 后失效重载。
- **校验**：schema 版本写入 Parquet metadata，启动时不匹配则报 `META_STALE`。

## §5 DDE 阶段主力净流入

跟 `metrics_*` 同槽位、与 K 线同节奏的资金面快照，让筛股 / 看板可以零额外
IO 用到「最近 N 日主力净流入 / N 日成交额」。

- **口径**：主力 = 超大单 + 大单（直接取 akshare 接口的"主力净流入"列）。
- **窗口**：`(3, 5, 10, 20)`，由 `quant_core.domain.types.fund_flow.DDE_WINDOWS`
  与 `@quant/shared` 的 `DDE_WINDOWS` 共同保持锁步；新增窗口必须三处同步。
- **来源**：akshare `stock_individual_fund_flow_rank(indicator="N日")`，
  一次调用返回全市场（~5500 行），4 个窗口共 4 次 RTT。
- **ratio 分母**：本地 `data/kline/*.parquet` 的 `amount` 列对最近 N 个交易日
  累加。不依赖 akshare 自带的"主力净占比"（口径与成交额不一定对齐，且仅部分
  窗口提供）。`amount` sum 为 0 或 kline 行数 < N → ratio 写 `null`，但
  net inflow 仍然落库。

### 字段（落 `stock_metas.parquet`，全部 nullable）

| 列名                          | 含义                                |
| ----------------------------- | ----------------------------------- |
| `dde_main_net_inflow_<N>d`    | 近 N 日主力净流入金额（CNY，可负）  |
| `dde_main_inflow_ratio_<N>d`  | 净流入 / 近 N 日成交额（可负）      |
| `dde_updated_at`              | 最近一次 DDE 同步的 UTC 时间戳      |

`<N>` ∈ {3, 5, 10, 20}。每次 upsert 写满 9 列（8 决策值 + 1 时间戳）。

### 触发链路

NestJS 侧 `StockFundFlowSyncService.syncAll()` 由 `BatchSettler` 在每次
meta + kline 包批次结算的尾段触发（在 blacklist 之后、动态板块刷新之前）。
Python 仅负责拉数 + 跨窗口 join（compute-only），写盘统一走
`LocalStockMetaWriterService.upsertFundFlow`，与 `upsertMetrics` /
`upsertMetas` 共享同一条 in-process write chain，永不竞争。

## §6 WCMI 波形质量综合分

WCMI（Wave-quality Composite Momentum Index）是落在 `stock_metas.parquet`
的 `metrics_*` 槽位的横截面综合分，用于排序板块/筛选/自选列表的 top-N
候选。详细设计与回测见 `docs/perf/wcmi-redesign.md` 与
`docs/perf/wcmi-redesign-backtest.md`。

**计算式**：设 $\mathrm{pct}_i(c) \in [0, 1]$ 为代码 $c$ 在子分维度 $i$
上的横截面百分位（仅在通过 survivor gate 的代码间排名），$w_i \ge 0$ 为权重，
$\sum_i w_i = 100$，则

$$\mathrm{WCMI}(c) = 10 \cdot \sum_i w_i \cdot \mathrm{pct}_i(c) \in [0, 1000]$$

- **窗口**：默认 90 个交易日（`WCMI_CONFIG.WINDOW`）。`bars < 30` ⇒
  `wcmi = null` 并退出；`30 ≤ bars < 90` 用现有 bar 数作为窗口
  fallback。
- **输出区间**：$[0, 1000]$（全部非负；中位数股票 $\approx 500$）。
  前端、IM 表渲染、排序默认均按 `wcmi desc` 跑（`DEFAULT_SORT_BY_KIND`）。
- **生存门**（survivor gate）：窗口期收益 $r_\text{window} \le 0$ 的代码
  `wcmi = null`，从所有排名表剔除。
- **子分**：7 个维度（per-code 横截面百分位 × 100）一并落库，
  composite null 时子分也都为 null：

  | 列名                  | 含义                                              |
  | --------------------- | ------------------------------------------------- |
  | `wcmi_rhythm`         | 滚动 ret_w 和 swing density 的"节奏"近 target 程度 |
  | `wcmi_ma_support`     | 收盘价对 MA20 的支撑/位置稳定度                   |
  | `wcmi_up_wave`        | 上行波段（连续阳柱簇）质量                        |
  | `wcmi_yang_dom`       | 阳柱主导度（实体 + 占比）                         |
  | `wcmi_shadow_clean`   | H−O / C−L 上下影线"干净"程度                      |
  | `wcmi_stage_gain`     | 自 `bars[0]` 起的阶段累计收益                     |
  | `wcmi_crash_avoid`    | 单日大跌 / 低开 / 未恢复 的避险表现               |

- **合成公式**：每个子分先做横截面百分位 $\text{pct}_i \in [0, 1]$，再按权重加权后缩放到 $[0, 1000]$：

  $$
  \text{WCMI} = \frac{\text{TOTAL\_SCALE}}{\sum_i w_i} \sum_i w_i \cdot \text{pct}_i
  $$

  默认 $\text{TOTAL\_SCALE} = 1000$，$\sum_i w_i = 100$，故 $\text{SCALE} = 10$。

- **默认权重**（调优后写回 `WCMI_CONFIG`，
  `apps/api/src/modules/stock-meta/domain/pure/wcmi-subscores/types.ts`）：
  `W_RHYTHM=0`、`W_MA_SUPPORT=3`、`W_UP_WAVE=3`、`W_YANG_DOM=3`、
  `W_SHADOW_CLEAN=3`、`W_STAGE_GAIN=28`、`W_CRASH_AVOID=60`（合 100）。
  rhythm 维持落库但权重为 0，自评结果显示与 label rhythm
  反相关（详 backtest changelog 2026-05-22 round 6）。
- **写盘**：composite 与 7 个子分通过 `LocalStockMetaWriterService.
  upsertMetrics` 一并落库，FE 通过 `StockListRow.wcmi*` 字段消费；
  EQ.LIST WCMI 列展示 composite，hover tooltip 列出 7 个子分百分位。
