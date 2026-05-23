# 需求文档

> 描述 **what** 与 **why**；**how** 在 `architecture.md` 与 `modules/*.md`。

## 1. 项目定位

**面向个人投资者的量化选股工作台**，基于 K 线技术形态 + 舆情消息面，辅助决策中短期交易（持仓周期：天 ~ 月）。

**不是**：

- 高频交易系统（无毫秒级延迟需求）
- 自动下单系统（v1 不接券商接口）
- 全自动量化策略回测平台
- 新闻聚合阅读器（聚焦"对价格有影响的"消息）

## 2. 用户画像

- 1~5 年 A 股投资经验的散户。
- 熟悉基本技术指标（MA、量价、形态），关注题材轮动。
- 工作流：先用条件筛出候选池，再人工细看。
- 偏好自然语言 + 点选交互，不要求懂代码。

## 3. 范围

### 3.1 v1（MVP）

- 市场：A 股全部三所（沪深北）。
- 频率：日线（OHLCV + 衍生）+ 盘中分钟（仅自选盯盘）。
- 周期：日内 → 月度。
- 基本面：仅元信息（行业、市值、上市时间）。

### 3.2 v1+ 候选

- 周线 / 月线、港股 / 美股、财报基本面、模拟回测。

## 4. 功能性需求

### F1. Stock Meta — `docs/modules/01-stock-meta.md`

- 维护本地全市场股票元信息（裸 6 位 code 主键）。
- 支持代码 / 名称 / 拼音 / 行业搜索。
- 增量同步由 NestJS 编排（`07-orchestration.md`）。

### F2. K 线 — `docs/modules/02-kline.md`

- 维护全市场日线 OHLCV + 换手率。
- **入库时预计算**：前复权价 + `ma5/10/20/60`（基于 `close_qfq`）。
- 每日盘后增量；除权除息日全量回算该股。
- 起点固定为北京时间 2024-09-20。
- 列存接口 (Arrow Flight)。

### F3. 选股 (DSL + NL2DSL) — `docs/modules/03-screen.md` + `rfcs/0001-screening-dsl.md`

- 自然语言 → DSL，最少正确翻译四类典型查询。
- 手写 DSL（JSON-AST）兜底，结果对用户可见可编辑。
- 支持条件块的交集 / 并集 / 差集。
- 命中带证据（具体日期、close、ma5 等）。
- 单条件 < 2s（5000+ 股票），10 条件以内 < 10s。

### F4. 形态拟合 — `docs/modules/04-pattern.md`

- 用户指定锚点 K 线段（来自某只股票或上传）。
- **始终在全市场宇宙**上匹配（Top-N）。
- v1：Z-score 归一化 + DTW；返回距离 + 对齐路径。
- 5000 股 × 30 日窗口扫描 < 30s。

### F6. 消息面 — `docs/modules/05-sentiment.md`

- `analyze_one(code)` / `analyze_many(codes)` 双方法。
- 信息源：LLM web_search（Kimi 等），覆盖研报 / 新闻 / 雪球 / 股吧。
- 单股七项关键字段 + 综合情绪评分；多股按主题归类 + 市场层综述。
- 结论必带 evidence；传闻显式 `is_rumor`。
- 结果缓存 `asof + 2 天`，支持 `fresh=1` 旁路。

### F7. 自选盯盘 — `docs/modules/06-watch.md`

- 用户维护若干盯盘宇宙；盘中分钟级刷新。
- match / hit 边沿语义（首次成立才推送，避免连发）。

### F8. 前端 — `docs/modules/08-frontend.md`

- 单用户本地工具，v1 不做鉴权；NestJS 监听 127.0.0.1。
- 技术栈：Chakra UI 3 + Zustand + TanStack Query + react-hook-form + zod。
- Pane 化工作台：所有功能 = Feat（`MODULE.FEATURE` 命名空间），统一 `<FeatView>` 包裹。
- 列表 ≥ 100 行必须虚拟化（`@tanstack/react-virtual`）。
- 偏好（pane 状态、上次输入）存 IndexedDB。

### F9. 后台编排 — `docs/modules/07-orchestration.md`

- 启动立即扫描 + 每 60 分钟一次 cron。
- 双触发：cron 周期 + HTTP 读时按需入队。
- 队列：**NestJS 进程内内存队列**（meta / kline / watch），任务幂等可重启；Redis + BullMQ 仅用于 channel 出站（IM 推送）持久重试。
- HTTP 读路径不阻塞补齐——返回当前缓存（含 stale），后台异步追平。

### F10. 通知 — `docs/modules/09-notifications.md`

- 项目内事件异步推送 IM（Slack / Feishu，统一走 `channel` 模块）。
- 路由可配；带去重（`(channel, dedupe_key)`）+ 限流；出站走 BullMQ 持久重试。

## 5. 非功能性需求

### N1. 性能

- 后端 P95 < 200ms（不含计算 / 外部 API；计算异步走 task_id）。
- 前端首屏 LCP < 2.5s。
- Python 服务单机内存 < 8GB。

### N2. 可靠性

- 数据源单点失效不阻塞读路径（读本地缓存）。
- 增量更新失败可断点续跑（`rfcs/0002-incremental-update-recovery.md`）。
- 关键作业失败必须告警（v1：日志 + 文件 marker；v2：webhook）。

### N3. 可观测性

- 跨进程调用全程 `trace_id`。
- 每日更新作业产出审计报告。
- LLM 调用记录 token 用量。

### N4. 安全

- 所有 API key 走 `.env`，禁止入代码。
- v1 不鉴权；NestJS 仅监听 127.0.0.1。

### N5. 可移植性

- 缓存抽象 ≥ 2 后端实现（v1：本地 Parquet；v2 候选：PostgreSQL / 对象存储）。
- 数据源 / LLM 抽象支持 ≥ 2 供应商；v1 实际接入：akshare（数据）+ DeepSeek / Kimi（LLM）。

## 6. 验收标准（DoD）

每个模块"完成"必须满足：

1. 模块文档（`docs/modules/0x-*.md`）写完且通过 review。
2. 公开接口（HTTP / Arrow Flight / Python API）有契约测试。
3. 单元 + 集成测试覆盖 ≥ 90% 行 / ≥ 80% 分支。
4. 关键链路 trace 日志可在审计报告中检索。
5. README 中可一键跑通 demo。

## 7. 已决策事项

- ✅ **LLM**：v1 引入 DeepSeek + Kimi；selection 由 `quant_io/llm/providers.py` 顺序 + `.env` 中实际存在的 API key 共同决定。
- ✅ **数据源**：v1 仅 akshare（聚合 sina / eastmoney）。
- ✅ **通知**：Slack + Feishu Web API（`channel` 模块）。
- ✅ **研报 PDF**：v1 仅取标题 + 摘要 + URL。
- ✅ **鉴权**：v1 不做；NestJS 监听 127.0.0.1。
- ✅ **市场范围**：A 股三所。
- ✅ **构建**：pnpm（TS）+ uv（Py）。
- ✅ **任务队列**：内存队列处理本地计算任务；Redis + BullMQ 仅用于 IM 出站持久重试。
