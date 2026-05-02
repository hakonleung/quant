# 术语表

> 项目内通用术语与缩写。代码、文档、UI 文案统一使用本表的中英文，避免分歧。

## A 股市场

| 术语         | 英文                  | 含义 / 项目约定           |
| ------------ | --------------------- | ------------------------- |
| A 股         | A-shares              | 沪深北交易所人民币普通股  |
| 沪市         | SH                    | 600/601/603/605/688 开头  |
| 深市         | SZ                    | 000/002/300 开头          |
| 北交所       | BJ                    | 8/4 开头                  |
| 主板         | MainBoard             |                           |
| 创业板       | ChiNext               | 300 开头，深市            |
| 科创板       | STAR                  | 688 开头，沪市            |
| 北交所板块   | BSE                   | 8/4 开头                  |
| 退市/ST/\*ST | delisted/risk_warning | F1 元信息 `status` 字段值 |

## 行情字段

| 术语        | 英文 / 字段               | 含义                                                               |
| ----------- | ------------------------- | ------------------------------------------------------------------ |
| 开/高/低/收 | open / high / low / close | 当日 OHLC                                                          |
| 成交量      | volume                    | 单位：股                                                           |
| 成交额      | amount                    | 单位：元                                                           |
| 换手率      | turnover_rate             | `volume / float_share`（小数，如 0.052 表示 5.2%）；UI 展示时 ×100 |
| 涨跌幅      | pct_chg                   | `(close - prev_close) / prev_close`（小数，如 0.02 表示 +2%）      |
| 涨停        | limit_up                  | 主板 ±10%、创/科 ±20%、北交 ±30%；判定走 `domain/rules/limit.py`   |
| 复权        | adjustment                | 见下节                                                             |

## 复权

| 术语   | 英文                    | 含义                                                             |
| ------ | ----------------------- | ---------------------------------------------------------------- |
| 不复权 | raw / no-adjust         | 历史原始价                                                       |
| 前复权 | qfq / forward-adjusted  | 以最新价为基准向前调整历史价；本项目**默认使用前复权**做技术分析 |
| 后复权 | hfq / backward-adjusted | 以首日价为基准向后调整                                           |

**项目约定**：日线表中同时存 `open/high/low/close`（不复权，原始）与 `open_qfq/high_qfq/low_qfq/close_qfq`（前复权）。MA 等指标基于 `close_qfq` 计算。

## 技术指标

| 术语 | 英文           | 含义                                            |
| ---- | -------------- | ----------------------------------------------- |
| MA   | Moving Average | 简单移动平均，`ma5/10/20/60` 对应 5/10/20/60 日 |
| EMA  | Exponential MA | 指数移动平均（暂未预计算，按需计算）            |
| MACD |                | 暂不预存，按需计算                              |
| KDJ  |                | 暂不预存                                        |
| 量比 | volume ratio   | 当日成交量 / 过去 N 日均量                      |

## 形态

| 术语           | 英文                               | 含义                                 |
| -------------- | ---------------------------------- | ------------------------------------ |
| K 线           | candlestick / kline                | 一根 = 一个交易日的 OHLC             |
| 形态           | pattern                            | 一段 K 线序列（窗口长度可变）        |
| Z-score 归一化 | z-score normalization              | `(x - mean) / std`，用于消除量级差异 |
| DTW            | Dynamic Time Warping               | 允许时间轴拉伸的相似度算法           |
| HNSW           | Hierarchical Navigable Small World | 近邻搜索索引（v2 引入）              |

## 舆情与新闻

| 术语         | 英文              | 含义                                                   |
| ------------ | ----------------- | ------------------------------------------------------ |
| 新闻         | news              | 公开市场信息（公告、媒体报道、社交平台）               |
| 研报         | research report   | 券商发布的个股 / 行业 / 策略报告                       |
| 主题 / 热点  | theme / hotspot   | 由 embedding 聚类得到的语义簇，例如"AI 算力"、"机器人" |
| 行业 / 板块  | industry / sector | 申万一级/二级/三级（默认 SW 分类）                     |
| 消息驱动因素 | price driver      | LLM 标注：哪条新闻是价格变动的最可能原因               |

## 数据源

| 术语              | 含义                        |
| ----------------- | --------------------------- |
| Tushare           | 主行情数据源（需 token）    |
| AKShare           | 兜底行情/新闻源             |
| Baostock          | 备用日线源（v2 视情况引入） |
| 同花顺 / 东方财富 | 研报数据兜底来源（v2）      |

## 工程缩写

| 缩写      | 含义                                                        |
| --------- | ----------------------------------------------------------- |
| DSL       | Domain-Specific Language（本项目指筛选 DSL，JSON-AST 形式） |
| AST       | Abstract Syntax Tree                                        |
| RSC       | React Server Components                                     |
| SSE       | Server-Sent Events                                          |
| RPC       | Remote Procedure Call                                       |
| RFC       | Request For Comments（项目内重大设计提案）                  |
| DTO       | Data Transfer Object                                        |
| qfq / hfq | 前复权 / 后复权                                             |
| MVP       | Minimum Viable Product                                      |

## 项目特定约定

- 所有 **日期** 用 `date`（不带时间），格式 ISO8601 `YYYY-MM-DD`
- 所有 **时间戳** 用 UTC `datetime`，格式 ISO8601 `YYYY-MM-DDTHH:mm:ssZ`
- 所有 **股票代码** 标准格式：`<code>.<exchange>`，如 `600519.SH` / `000001.SZ` / `430047.BJ`
- 所有 **金额** 单位：元；**成交量** 单位：股
- **涨跌幅 / 换手率** 均用小数（0.05 = 5%），UI 展示时再 ×100
