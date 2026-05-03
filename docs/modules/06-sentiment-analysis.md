# 模块 06 — 消息面分析（news-sentiment）

> v2 改版：原模块 05（新闻和研报本地库）与本模块合并。本项目**不再维护本地新闻库 / 研报库**，所有外部信息一律走 **Kimi 内置 `$web_search`**；本模块只缓存 LLM 输出结果，不缓存原始新闻。
> 旧文档 `05-news-research.md` 已停用，仅留指向本文件的占位说明。

## 1. 职责

输入：股票或股票集合 + 时间窗口（默认 30 天）。
输出：按既定字段集合产出消息面摘要；多股票场景下进一步按"最相关题材"归类，给出市场层 / 产业层趋势洞察。

只用 Kimi `$web_search`。本模块**没有本地新闻 / 研报缓存**，也不通过 AKShare 拉新闻 / 研报；所有原文证据都来自实时联网检索的 URL，结论必须可溯源到 URL。

## 2. 暴露的两个关键方法

```python
# services/news_sentiment_service.py
class NewsSentimentService:
    def analyze_one(
        self,
        code: str,
        *,
        days: int = 30,
        asof: date | None = None,
        bypass_cache: bool = False,
    ) -> StockSentiment: ...

    def analyze_many(
        self,
        codes: Sequence[str],
        *,
        days: int = 30,
        asof: date | None = None,
        bypass_cache: bool = False,
    ) -> MarketSentiment: ...
```

- `analyze_one`：单股分析。命中本地结果缓存（§5）则直接返回；未命中走 Kimi web_search → LLM 抽取 → 结构化输出 → 落缓存。
- `analyze_many`：基于 `analyze_one`（并发上限 = 8）批量产出 `StockSentiment[]`，再做一次 LLM 归类 → 题材簇 → 市场 / 产业趋势综述。**两个方法都不走 LangGraph**——graph 在 v1 版本中带来的复杂度与本模块当前规模不匹配，节点重试/进度上报靠 `LLMChain` + 简单 `asyncio.gather` + SSE 事件流即可（见 §6）。

## 3. 输入采集：Kimi `$web_search`

### 3.1 调用方式

```python
response = kimi.chat(
    messages=[
        {"role": "system", "content": SYS_PROMPT},
        {"role": "user", "content": user_prompt(stock_meta, asof, days)},
    ],
    tools=[{"type": "builtin_function", "function": {"name": "$web_search"}}],
    schema=StockSentimentRaw,         # 强约束输出结构
)
```

LLM 自主决定调用 `$web_search` 的次数与 query；`LLMChain` 自动 echo `tool_calls` 直至模型 `finish_reason="stop"`。详见 `docs/integrations/llm-providers.md` §3.1。

### 3.2 检索覆盖面（由 system prompt 强制）

每只股票的检索必须覆盖以下 5 类来源；prompt 通过具体 query 模板引导 LLM 在不同 round 触发不同来源：

| 来源类别 | 典型站点关键词                              | 用途                                        |
| -------- | ------------------------------------------- | ------------------------------------------- |
| 研报     | `券商 + 研报 + {name}` / `target price`     | 评级、目标价、卖方观点、目标涨幅            |
| 新闻     | `{name} OR {code}` 限定财经媒体             | 公司公告、并购、业绩、产品                  |
| 雪球     | `xueqiu.com {code}`                         | 散户 + 中长线投资者讨论、情绪、交易逻辑     |
| 股吧     | `guba.eastmoney.com {code}`                 | 短线情绪、传闻、风险点                      |
| 行业资讯 | `{industry} 政策 / 涨价 / 供需 / 产业链` | 行业景气、价格信号、政策催化、供需关系趋势 |

prompt 必须显式要求 LLM 在每只股票分析时**至少触达 3 类来源**（研报 + 新闻 + 行业资讯为强制项；雪球/股吧根据热度触发）。漏掉的来源类别在输出中以 `coverage_gaps: list[str]` 反馈，UI 据此显式提示用户。

### 3.3 配额与降级

- 每只股票最多 **8 次** `$web_search` 调用；任务级总上限 **400 次**（由 `LLMChain` 计数）
- 单股 quota 耗尽 → 模型直接产出基于现有 search 结果的输出，并在 `caveats` 中说明
- Kimi 整体 quota 耗尽（`LLMQuotaExhausted`） → 抛 `SentimentUnavailable` 给上层；**没有降级 provider**（DeepSeek 当前无等价 web search，盲撞会得到无依据的结论）
- 单次 `$web_search` 失败（429 / 网络）→ 跳过当次，不阻塞任务

## 4. 输出契约

### 4.1 单股输出 `StockSentiment`

```python
# domain/types/sentiment.py
@dataclass(frozen=True, slots=True)
class StockSentiment:
    code: str
    asof: date
    window_days: int

    # 七项关键洞察（每项可缺失，缺失走 None / 空 list）
    core_drivers: list[Insight]              # 上涨核心驱动（3~5 条）
    m_and_a: list[Insight]                   # 并购 / 重组（含传闻；is_rumor 标注）
    hot_themes: list[ThemeTag]               # 当前所属热点题材
    core_products: list[ProductInfo]         # 核心产品 + 占比
    price_signals: list[PriceSignal]         # 产品涨价 / 缺货 / 去库存等信号
    supply_demand: list[Insight]             # 中长期供需关系趋势
    research_targets: list[ResearchTarget]   # 研报目标价 / 目标涨幅
    competitive_landscape: CompetitiveLandscape | None  # 竞争格局（高优先级）

    sentiment_score: float                   # 综合情绪评分 [-1, 1]
    coverage_gaps: list[str]                 # 未触达的来源类别（如 ["xueqiu"]）
    caveats: list[str]
    fetched_at: datetime

@dataclass(frozen=True, slots=True)
class Insight:
    summary: str                             # 一句话
    direction: Literal["positive", "negative", "neutral"]
    confidence: float                        # 0~1
    is_rumor: bool                           # True = 未证实；UI 标灰
    evidence: list[Evidence]                 # ≥ 1，否则该条不输出

@dataclass(frozen=True, slots=True)
class Evidence:
    source_type: Literal["research", "news", "xueqiu", "guba", "industry"]
    quoted_text: str                         # 原文片段（≤ 200 字）
    url: str
    published_at: date | None

@dataclass(frozen=True, slots=True)
class ThemeTag:
    label: str                               # LLM 命名，如 "AI 算力 - 国产 GPU"
    relevance: float                         # 0~1
    rationale: str
    evidence: list[Evidence]

@dataclass(frozen=True, slots=True)
class ProductInfo:
    name: str
    revenue_share_pct: float | None          # 营收占比，未披露为 None
    note: str | None

@dataclass(frozen=True, slots=True)
class PriceSignal:
    product: str
    change: Literal["price_up", "price_down", "shortage", "destock", "stable"]
    magnitude: str | None                    # 如 "+15%"
    horizon: Literal["spot", "short_term", "mid_term"]
    evidence: list[Evidence]

@dataclass(frozen=True, slots=True)
class CompetitiveLandscape:
    """高优先级字段：识别 2~6 个具名竞争对手 + 公司市场地位 + 护城河 + 风险。

    `competitive_landscape = None` 仅在主动检索后仍无可用证据时使用，
    并在 `caveats` 加入 "已检索但未发现竞争格局信号"。
    """
    market_position: Literal["leader", "challenger", "follower", "niche", "unclear"]
    market_share_pct: float | None           # 公司在主营市场份额；无可信来源置 None
    summary: str                             # 一段话竞争格局总览
    competitors: list[CompetitorInfo]        # 2~6 个具名竞争对手
    moats: list[str]                         # 护城河：技术 / 客户 / 成本 / 渠道 / 牌照 / 规模
    risks: list[str]                         # 竞争劣势 / 被替代风险
    evidence: list[Evidence]                 # ≥ 1，否则该 landscape 整体丢弃

@dataclass(frozen=True, slots=True)
class CompetitorInfo:
    name: str                                # 具名公司或产品
    relation: Literal["domestic_peer", "foreign_peer", "substitute", "upstream", "downstream"]
    threat_level: Literal["high", "medium", "low"]
    note: str                                # ≤ 80 字：产品重叠 / 技术差距 / 客户重合
    evidence: list[Evidence]                 # ≥ 1

@dataclass(frozen=True, slots=True)
class ResearchTarget:
    broker: str
    rating: str | None                       # "买入" / "增持" / ...
    target_price: Decimal | None
    target_upside_pct: Decimal | None        # 目标涨幅
    horizon_months: int | None
    report_date: date | None
    url: str
```

**硬约束**：`Insight` / `ThemeTag` / `PriceSignal` / `ResearchTarget` 至少有一条 `Evidence`，否则该条不写入输出。schema 校验失败 → `LLMSchemaError` → 重试一次（见 `llm-providers.md` §4）。

### 4.2 多股输出 `MarketSentiment`

```python
@dataclass(frozen=True, slots=True)
class MarketSentiment:
    asof: date
    window_days: int
    per_stock: dict[str, StockSentiment]     # code -> StockSentiment
    theme_clusters: list[ThemeCluster]       # 题材归类
    market_trend: MarketTrend                # 市场层趋势
    industry_trends: list[IndustryTrend]     # 产业层趋势
    caveats: list[str]
    fetched_at: datetime

@dataclass(frozen=True, slots=True)
class ThemeCluster:
    theme_label: str                         # LLM 命名
    member_codes: list[str]                  # 归属股票（基于其 hot_themes 中 relevance 最高的题材）
    related_industries: list[str]            # SW L2 代码
    heat_score: float                        # 综合：成员数 × 时间衰减 × 平均 sentiment_score
    trend: Literal["rising", "stable", "fading"]
    summary: str
    top_evidence: list[Evidence]             # 来自成员股票的代表性证据

@dataclass(frozen=True, slots=True)
class MarketTrend:
    summary: str                             # 一段话
    style_signals: list[StyleSignal]         # 同 v1：成长/价值、大小盘、防御/进攻
    caveats: list[str]

@dataclass(frozen=True, slots=True)
class IndustryTrend:
    industry: str                            # SW L2 代码或行业名
    summary: str
    direction: Literal["improving", "stable", "deteriorating"]
    drivers: list[str]                       # 触发因素
    risks: list[str]
    related_themes: list[str]                # 关联 ThemeCluster.theme_label
```

### 4.3 题材归类规则

每只股票的 `hot_themes` 按 `relevance` 排序，**取 top1 作为该股的"最相关题材"** 用于归类。归类发生在 `analyze_many` 的最后一步：

1. 收集所有股票的 top1 theme label
2. 用 LLM（不带 `$web_search`，纯文本 reasoning）对相似 label 做合并（如 "AI 算力" / "国产 GPU" / "AI 芯片" → "AI 算力 - 国产 GPU"）
3. 合并后形成 `ThemeCluster`，`member_codes` 为该簇的股票列表
4. 同股可能命中多个主题（top2/top3），UI 上以"次要归属"次级展示，不进入 `member_codes`

不再使用 v1 的 bge-m3 + HDBSCAN 聚类——题材数量小（典型 5~20），LLM 直接归并比向量聚类质量更高、链路更短。

## 5. 结果缓存（必须）

LLM 调用昂贵，结果缓存是模块的硬需求。

### 5.1 缓存层级

| 层级          | Key                                                  | 过期时间        | 备注                                                       |
| ------------- | ---------------------------------------------------- | --------------- | ---------------------------------------------------------- |
| 单股结果      | `(code, asof, window_days, schema_version)`          | `asof + 2 天`   | 命中 → 直接返回 `StockSentiment`                           |
| 多股聚合结果  | `(sorted(codes), asof, window_days, schema_version)` | `asof + 2 天`   | 命中 → 直接返回 `MarketSentiment`；不命中重新组装           |
| LLM prompt 级 | 同 `CachingLLM`（`llm-providers.md` §6）             | 24h             | 兜底层；用户改 prompt 不命中，但相同 prompt 命中 0 成本     |

**为什么是 `asof + 2 天`**：消息面以"截止某交易日"的视角分析，结果在该日的次日（盘前 / 盘中复用）和次次日（盘后复盘）仍然有效；再之后题材已经轮动，结论失去时效。统一两层都用 asof+2 天，简化失效语义。具体过期时刻 = `datetime(asof + 2 days, 00:00, UTC)`，超过即失效。

### 5.2 实现端口

```python
# ports/sentiment_cache.py
class SentimentCache(Protocol):
    def get_stock(self, key: StockSentimentKey) -> StockSentiment | None: ...
    def put_stock(self, key: StockSentimentKey, value: StockSentiment, ttl_sec: int) -> None: ...
    def get_market(self, key: MarketSentimentKey) -> MarketSentiment | None: ...
    def put_market(self, key: MarketSentimentKey, value: MarketSentiment, ttl_sec: int) -> None: ...
    def invalidate_stock(self, code: str) -> None: ...   # 用户在 UI 强制重算
```

v1 默认实现：`ParquetSentimentCache` —— 与 `ParquetKlineRepo` 同构（每个实体一个 Parquet 文件 + `filelock` 串行写 + `tmpfile + os.replace + fsync` 原子提交 + 读路径无锁）。

```
data/sentiment/
├── stock/
│   ├── 002980.parquet          # 一只股票多条 (asof, window_days) 历史
│   └── 600519.parquet
└── market/
    └── <codes_hash>.parquet    # 一组代码（sorted+dedup 后取 sha256[:32]）的多条历史
```

每个 Parquet 行的列（见 `quant_cache.sentiment_schema`）：

| 列                | 类型                       | 说明                                           |
| ----------------- | -------------------------- | ---------------------------------------------- |
| `code` / `codes_hash` | string                 | 单股: 股票代码；多股: codes 哈希                |
| `asof`            | date32                     | 截止日                                         |
| `window_days`     | int32                      | 用户指定的分析窗口                             |
| `schema_version`  | int32                      | 不同版本的行共存，读时按版本过滤               |
| `fetched_at`      | timestamp[us, UTC]         | 写入时刻                                       |
| `expires_at`      | timestamp[us, UTC]         | `asof + 2 天 @ 00:00 UTC`，读时过滤过期行      |
| `sentiment_score` | float64（仅单股）           | 顶层提出来便于将来跨股扫描                     |
| `payload_json`    | string                     | 整个嵌套结构（Insight/ThemeTag/CompetitorInfo 等）的 JSON 字符串 |

**为什么不把整个嵌套结构展平成 Parquet 列**：``Insight`` / ``ThemeTag`` / ``CompetitorInfo`` 各自带自己的 ``Evidence`` 列表，强行平铺需要 ~30 个 nested struct 列，每次 schema 微调就要写迁移；行级 `payload_json` 让 schema 演进只需要 bump `schema_version`。

**为什么按 kline 模式（每实体一个 Parquet）而不是 KV / 单文件**：
* 多次分析（同股不同 asof / window_days）共用一个文件，写入摊销 IO
* 跨股分析（如"扫描所有 sentiment_score < 0 的股票"）将来可走 DuckDB `read_parquet`，与 kline 共用同一套查询模式
* 文件锁 + 原子写让并发 worker 安全
* 旧版本行因 `schema_version` 过滤自动失效，无需迁移脚本

**TTL 与失效**：`expires_at` 在写入时根据 `asof + 2 天 @ 00:00 UTC` 计算并落库；读路径过滤 `expires_at > now()`。`invalidate_stock(code)` 直接删除整个 `stock/<code>.parquet`，所有历史一并清空。

### 5.3 失效

- 自然 TTL 过期 → 下次读时检测并删
- 用户在 UI 点 "强制刷新" → `invalidate_stock(code)` / `bypass_cache=True`
- schema_version 变化（重大字段调整）→ 整目录失效（启动时扫描）

## 6. 进度上报与并发

`analyze_many` 通过 SSE 推回前端：

```jsonc
{ "stage": "per_stock", "code": "600519", "status": "running", "progress": 0.4 }
{ "stage": "per_stock", "code": "600519", "status": "done" }
{ "stage": "cluster_themes", "status": "running" }
{ "stage": "market_trend",   "status": "running" }
{ "stage": "done",           "result_summary": { ... } }
```

实现：

- `asyncio.Semaphore(8)` 限制 per-stock 并发
- 每只股票完成时往 `asyncio.Queue` push 一条事件
- gRPC `StreamSentimentProgress` 从队列消费；NestJS fan-out 给前端

**没有 LangGraph**：本模块只有 "per_stock × N → 归类 → 综述" 三步，纯线性。LangGraph 的 checkpoint / 重试 / 条件分支用不上；硬上反而稀释模块边界。`docs/integrations/workflow-langgraph.md` 的 sentiment graph 章节随本次合并废弃。

## 7. 端口

```python
class LLMPort(Protocol):
    def chat(self, messages, *, schema, tools, ...) -> LLMResponse: ...

# 没有 EmbeddingPort —— v2 改版后不再需要本地嵌入
```

## 8. NestJS HTTP API

| Method | Path                              | Body / Query                        | Response                                          |
| ------ | --------------------------------- | ----------------------------------- | ------------------------------------------------- |
| GET    | `/api/sentiment/stock/:code`      | `?days=30&asof=YYYY-MM-DD&fresh=0`  | `StockSentimentDto`                               |
| POST   | `/api/sentiment/analyze`          | `{ codes: string[], days: number }` | `{ task_id }`                                     |
| GET    | `/api/sentiment/tasks/:id`        | —                                   | `{ status, progress, result?: MarketSentiment }`  |
| GET    | `/api/sentiment/tasks/:id/stream` | —                                   | SSE 流（§6）                                      |

`fresh=1` 等价于 `bypass_cache=True`。

## 9. 性能与成本预算

| 输入规模              | 预算                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| 单股（缓存命中，asof+2 天内）| < 50ms                                                          |
| 单股（冷启动）        | < 30s（受 Kimi `$web_search` 延迟主导）                               |
| 50 股（全冷）         | < 4 min（并发 8 + 归类 + 综述）                                       |
| Kimi `$web_search` 数 | 单股 ≤ 8 次；50 股任务 ≤ 400 次                                       |
| LLM token             | 单股 ≤ 6k input + 1.5k output；50 股聚合归类额外 ≤ 30k input + 5k out |

成本控制完全依赖 §5 的结果缓存 + `CachingLLM`。

## 10. 测试要求

### 10.1 unit（pure 部分）

- `sentiment_score` 聚合规则
- 题材合并的 LLM 输出 → `ThemeCluster` 的转换逻辑（不调 LLM，直接喂 fixture）
- 缓存 key 计算（`sorted(codes)` + asof + days 的稳定哈希）
- schema 校验：缺失 `evidence` 的 `Insight` 必须被 LLMChain 拒绝

### 10.2 integration

- `ReplayLLM` + 真实服务：录制一只股票完整 web_search 交互，回放跑通 `analyze_one`，断言七项字段都被填充或合理为空
- 缓存命中：第二次调用同 key 不进 LLM
- `analyze_many`：3 只股票（mock per_stock 输出）→ 断言 cluster + market_trend 结构合法

### 10.3 contract

- `StockSentiment` / `MarketSentiment` 的 zod 与 pydantic schema 一致（共享 `proto/`，由生成器产出）
- 缓存格式跨版本：v1 写入的 JSON 在 schema_version 升级后能被识别 + 触发失效

### 10.4 LLM 行为测试（独立标记，不进默认 CI）

- 用真实 Kimi 跑一组 golden 输入；人工评估七项字段的合理性、evidence URL 的可达性、题材命名贴切度

## 11. 风险与备注

- **`$web_search` 是单点依赖**：Kimi 服务异常时本模块直接不可用，没有降级（DeepSeek 无等价能力）。可观测性必须把 Kimi 错误率单列；连续失败 5 分钟触发通知（见 `docs/modules/08-notifications.md`）。
- **可解释性 > 准确性**：所有结论必须带 evidence URL；空 evidence 一律不输出。UI 展示低于 0.5 confidence 的条目标灰。
- **传闻标注**：并购、产品涨价等容易掺传闻的字段，LLM 必须显式输出 `is_rumor`；UI 区分展示。
- **不构成投资建议**：所有 UI 输出页脚强制声明。
- **数据时效**：缓存 TTL 是性能与时效的折衷；用户在重大事件（业绩 / 公告）后应用 `fresh=1` 强刷。
- **历史回看**：本模块只面向 "近期 N 天" 分析，不做时间序列归档。如需研究历史某天的市场情绪，v2 再设计快照机制。
