# 需求文档

> 本文件描述 **what** 和 **why**，不描述 **how**。`how` 在 `architecture.md` 与 `modules/*.md`。

## 1. 项目定位

**面向个人投资者的量化选股工作台**，基于 K 线技术形态 + 舆情消息面，辅助决策中短期交易（持仓周期：天 ~ 月）。

**不是**：

- 高频交易系统（无毫秒级延迟需求）
- 自动下单系统（v1 不接券商接口）
- 全自动量化策略回测平台（不是 backtrader/zipline 替代品）
- 新闻聚合阅读器（聚焦"对价格有影响的"消息）

## 2. 用户画像

- **主用户**：有 1~5 年 A 股投资经验的散户/个人投资者
- 熟悉基本技术指标（MA、MACD、KDJ、量价、形态）
- 关注题材/热点轮动，会主动跟踪行业新闻和券商研报
- 偏好"先用条件筛出候选池，再人工细看"的工作流
- 不要求懂代码；与系统交互以**自然语言**和**点选交互**为主

## 3. 范围

### 3.1 v1 范围（MVP）

- 市场：**A 股（沪深北）全部上市股票**
- 数据频率：**日线**为主（含成交量、成交额、换手率等衍生）
- 分析周期：日内 → 月度（不支持分钟/秒级数据）
- 基本面深度：仅取行业、市值、上市时间等元信息（v1 不做财报深度分析）

### 3.2 v1+ 候选（明确排期前不实现）

- 周线 / 月线
- 港股 / 美股
- 财报基本面分析、估值模型
- 模拟回测引擎
- 实时盘中数据

## 4. 核心模块（功能性需求）

### F1. 股票基础信息（`docs/modules/01-stock-meta.md`）

- **F1.1**：维护本地全市场股票元信息（裸 6 位 code 为主键）：`code, name, name_pinyin, industries, list_date, float_pct`（具体字段定义见 `docs/modules/01-stock-meta.md` §2）
- **F1.2**：增量更新由 NestJS 编排（cron + 读时按需补，详见 `docs/modules/09-update-orchestration.md`），失败时不影响其它模块
- **F1.3**：提供按代码、名称（含拼音首字母）、行业的查询

### F2. 股票日线数据（`docs/modules/02-stock-kline.md`）

- **F2.1**：维护本地全市场日线 OHLCV：`open, high, low, close, volume, amount, turnover_rate`
- **F2.2**：**入库时预计算并落库**：
  - 前复权价：`open_qfq, high_qfq, low_qfq, close_qfq`
  - 基于前复权 close 的均线：`ma5, ma10, ma20, ma60`
- **F2.3**：每日收盘后增量更新（由 NestJS 编排，详见 `docs/modules/09-update-orchestration.md`）；除权除息日全量回算前复权与均线（仅该股票）；全市场起点固定为北京时间 2024-09-20
- **F2.4**：提供按 (code, date_range) 拉取的列存接口（Arrow Flight）

### F3. 股票筛选（`docs/modules/03-screening.md` + `rfcs/0001-screening-dsl.md`）

- **F3.1**：支持自然语言输入，转成结构化 DSL 后执行。最少必须能正确翻译以下 4 类：
  1. "最近 5 天每天股价都高于 ma5"
  2. "最近 10 天平均换手率小于 10%"
  3. "最近 20 天涨幅大于 30%"
  4. "连续 5 天每天涨幅大于 2%"
- **F3.2**：支持手写 DSL（JSON-AST）兜底，所有 NL 转换结果对用户可见可编辑
- **F3.3**：支持多个条件块的**交集 / 并集 / 差集**操作
- **F3.4**：执行结果带"命中原因"——每只股票被筛中的具体证据（如哪天的 close、ma5 值）
- **F3.5**：执行时间：单条件 < 2s（覆盖全市场 5000+ 股票），10 条件以内组合 < 10s

### F4. 形态拟合（`docs/modules/04-pattern-matching.md`）

- **F4.1**：用户选定参考形态（一段 K 线序列，可来自某只股票的某段时间，或手画/上传）
- **F4.2**：在指定股票池（默认 = F3 结果）+ 指定窗口长度（如 30 日）下，找出形态最相似的 Top-N 股票
- **F4.3**：相似度算法 v1 用 Z-score 归一化 + DTW；返回距离分数与对齐路径
- **F4.4**：执行时间：5000 股票 × 30 日窗口扫描 < 30s（v1 可放宽，v2 加 HNSW 索引）

### F5. （已废弃）

原"新闻和研报本地库"模块在 v2 改版中合并入 F6；项目不再维护本地新闻 / 研报缓存。占位编号保留，避免下游编号混乱。

### F6. 消息面分析（`docs/modules/06-sentiment-analysis.md`）

- **F6.1**：暴露两个公共方法：
  1. `analyze_one(code, days)` — 单股消息面分析
  2. `analyze_many(codes, days)` — 多股分析（基于 1）+ 题材归类 + 市场/产业趋势综述
- **F6.2**：信息源**只**用 Kimi 内置 `$web_search`，覆盖：研报 / 新闻 / 雪球 / 股吧 / 行业资讯
- **F6.3**：单股输出包含七项关键字段：上涨核心驱动、并购（含传闻）、热点题材、核心产品、产品涨价信号、中长期供需关系、研报目标涨幅，外加综合情绪评分
- **F6.4**：多股场景下，按"最相关题材"归类成 `ThemeCluster`；产出市场层风格判断与产业层趋势洞察
- **F6.5**：所有结论必须带 evidence（原文片段 + URL）；传闻字段显式标注 `is_rumor`
- **F6.6**：单股 / 多股结果必须接入本地结果缓存，过期时间统一为 `asof + 2 天`；可强制 `fresh=1` 旁路

### F7. 前端模块（`docs/modules/07-frontend.md`）

- **F7.1**：单用户本地工具，v1 **不做鉴权**（默认绑定本机访问；外网部署再加）。技术栈：Chakra UI + Zustand + react-query + react-hook-form + zod
- **F7.2**：传统股票列表 — 表头排序、搜索、虚拟滚动（≥ 5000 行）
- **F7.3**：个股详情 — K 线蜡烛图（默认 90 交易日，叠加 MA）+ 个股资料 + 手动触发个股消息面更新
- **F7.4**：板块 —
  - 用户板块：手动添加个股；可对成员做消息面归类
  - 动态板块：保存 NL 筛选语句，结果表动态追加 screen 证据列
  - 多选板块合并为只读临时板块
  - 个股 / 任意文本 / 已生成的消息面均可透传 NestJS 推送至 Slack
- **F7.5**：黑名单 — 加入 / 管理 / 全局屏蔽
- **F7.6**：用户配置（板块、黑名单、设置）使用 IndexedDB + Zustand persist 在浏览器持久化（匿名用户）
- **F7.7**：K 线交互特色 —
  - 单击 K 线：上方 label 显示自该日至今涨跌幅
  - 连续点击两根 K 线进入 pattern match 模式，触发后端返回相似股票区间走势
- **F7.8**：输入框与 AI 生成内容统一使用 terminal 风格渲染

### F8. 通知（`docs/modules/08-notifications.md`）

- **F8.1**：项目内事件（数据更新失败、LLM quota、用户订阅命中）异步推送至 IM；v1 渠道 = Slack
- **F8.2**：路由可配置（按 source + severity）；自带去重（按 `(source, dedupe_key, window)`）与限流（每渠道令牌桶）
- **F8.3**：所有投递写 audit jsonl，失败投递有兜底 channel

### F9. 更新编排（`docs/modules/09-update-orchestration.md`）

- **F9.1**：NestJS 启动后**立即**触发一次缓存扫描，之后每 **60 分钟** 一次
- **F9.2**：双触发模式 — cron 周期扫描 + HTTP 读时按需入队
- **F9.3**：meta / kline 各自独立 BullMQ 队列；kline worker 受令牌桶 + 指数退避 + 熔断保护，遇 rate limit 自动延迟
- **F9.4**：HTTP 读路径**不阻塞**等待补齐 — 用户当次拿到当前缓存内容（含 stale 行），后台异步补

## 5. 非功能性需求

### N1. 性能

- 后端 P95 < 200ms（不含计算与外部 API；计算走异步任务返回 task_id）
- 前端首屏 LCP < 2.5s
- 计算服务单机内存占用 < 8GB（不含 LLM 推理；LLM 走外部 API）

### N2. 可靠性

- 数据源单点失效不阻塞读路径（读本地缓存）
- 增量更新失败可断点续跑（详见 `rfcs/0002-incremental-update-recovery.md`）
- 关键作业（每日数据更新）失败必须告警（v1：日志 + 文件 marker；v2：webhook）

### N3. 可观测性

- 所有跨进程调用带 `trace_id`，全链路可串
- 每日更新作业产出审计报告（成功/失败/重试次数/数据量）
- LLM 调用记录 token 用量与成本

### N4. 安全

- 所有外部 API key 走 `.env` + 加载时校验，绝不进代码
- LLM prompt 不泄露用户敏感数据（v1 单用户场景下风险可控，但仍隔离）
- v1 不做鉴权；NestJS 仅监听 `127.0.0.1`，禁止监听 `0.0.0.0`；任何外网部署需求触发先做鉴权再开放

### N5. 可移植性

- 缓存抽象支持 ≥ 2 种后端实现（v1：本地 Parquet；v2：可切换 PostgreSQL/Redis）
- 数据源抽象支持 ≥ 2 个供应商（v1：仅接入 AKShare 一家，端口形态保留 N≥2；二源接入计划见 `docs/todo-enhancement.md`）
- LLM 抽象支持 ≥ 2 个供应商（v1：deepseek + kimi，主路 / 兜底由 env 配置；先 PK 再钦定）

## 6. 验收标准（DoD）

每个模块"完成"必须满足：

1. 该模块文档（`docs/modules/0x-xxx.md`）写完且通过 review
2. 公开接口（HTTP / Arrow Flight RPC / Python API）有契约测试
3. 单元测试 + 集成测试覆盖 ≥ 90% 行覆盖、≥ 80% 分支覆盖
4. 关键链路有 trace 日志且能在审计报告中找到
5. README 中可一键跑通 demo（提供 sample 数据）

## 7. 术语与缩写

详见 `docs/glossary.md`。

## 8. 已决策事项

- ✅ **LLM**：v1 引入 deepseek + moonshot 两家；selection 由 `services/py/quant_io/llm/providers.py` 的硬编码目录顺序 + `.env` 中实际存在的 API key 共同决定（详见 `docs/integrations/llm-providers.md` §10）
- ✅ **新闻源**：v1 仅 AKShare（含其后端聚合 sina / eastmoney）；之后看效果再加东方财富 / 同花顺爬虫
- ✅ **通知**：v1 推送到 Slack（incoming webhook 起步，必要时切 bot token）；微信 / 飞书等其它 IM 留 v2
- ✅ **研报 PDF**：v1 仅取标题 + 摘要 + URL，不解析正文；之后看效果再加
- ✅ **鉴权**：v1 不做；NestJS 监听 127.0.0.1
- ✅ **市场范围**：A 股全部三所（沪深北）
- ✅ **构建工具**：pnpm（TS）+ uv（Py），不用 Makefile
