# 模块 06 — 消息面分析（sentiment-analysis）

## 1. 职责

输入：股票集合（典型为筛选/形态结果） + 时间窗口。
输出：三层洞察 — **个股价格驱动消息** / **行业题材热点** / **市场层风格与中长期支撑判断**。

底层用 LangGraph 编排多步 LLM + 向量聚类，所有结论必须可溯源到原文片段。

## 2. 三层输出契约

```python
# domain/types/sentiment.py

@dataclass(frozen=True, slots=True)
class StockDriver:
    code: str
    drivers: list[PriceDriver]      # 3~5 条

@dataclass(frozen=True, slots=True)
class PriceDriver:
    summary: str                    # 一句话
    direction: Literal["positive", "negative", "neutral"]
    confidence: float               # 0~1
    evidence: list[Evidence]        # 引用的原文片段

@dataclass(frozen=True, slots=True)
class Evidence:
    source_id: str                  # NewsItem.id 或 ResearchReport.id
    source_type: Literal["news", "report"]
    quoted_text: str                # 原文片段
    url: str

@dataclass(frozen=True, slots=True)
class ThemeCluster:
    theme_label: str                # LLM 命名，如 "AI 算力 - 国产 GPU"
    member_codes: list[str]         # 归属股票
    related_industries: list[str]   # SW L2 代码
    heat_score: float               # 综合：新闻数 × 时间衰减 × 个股近期涨幅
    trend: Literal["rising", "stable", "fading"]
    summary: str
    top_evidence: list[Evidence]

@dataclass(frozen=True, slots=True)
class StyleSignal:
    """市场风格信号；name 为机读 key，rationale 是 LLM 一句话理由。"""
    name: Literal[
        "growth_over_value", "value_over_growth",
        "large_cap_outperform", "small_cap_outperform",
        "defensive_over_offensive", "offensive_over_defensive",
        "high_beta", "low_beta",
    ]
    confidence: float               # 0~1
    rationale: str
    supporting_evidence: list[Evidence]

@dataclass(frozen=True, slots=True)
class MarketView:
    asof: date
    style: list[StyleSignal]
    themes: list[ThemeCluster]      # 当前热点排名
    long_term_support: list[FundamentalThesis]   # 中长期支撑判断
    caveats: list[str]              # LLM 的不确定性声明

@dataclass(frozen=True, slots=True)
class FundamentalThesis:
    thesis: str                     # 一句话
    supporting_themes: list[str]
    supporting_evidence: list[Evidence]
    risk_factors: list[str]
```

## 3. LangGraph 流程

```
                    ┌──────────────┐
                    │   Input      │
                    │ (codes,      │
                    │  window)     │
                    └──────┬───────┘
                           ▼
              ┌────────────────────────┐
              │ N1: gather_evidence    │  并发拉取每只股票的 news + reports
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ N2: per_stock_drivers  │  对每只股票 LLM 抽取 3~5 条 PriceDriver
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ N3: embed_corpus       │  bge-m3 嵌入全部新闻摘要 + driver
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ N4: cluster_themes     │  HDBSCAN 聚类 → 候选主题簇
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ N5: name_themes        │  LLM 给每个簇命名 + 摘要 + heat_score
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │ N6: market_synth       │  LLM 综合：风格判断 + 中长期支撑
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │   Output: MarketView   │
              │   (含三层)              │
              └────────────────────────┘
```

每个节点：
- 失败可重试（最多 2 次，指数退避）
- 状态可持久化（LangGraph checkpoint），断点续跑
- 进度通过 SSE 推回前端：`{ node, status, progress, partial_result }`

## 4. 各节点细节

### 4.1 N1: gather_evidence
- 调 `NewsService.for_codes(codes, days)` + `ReportService.for_stock` × N
- 全部走本地缓存；缓存缺失时**不**实时拉取（保证响应时间），返回 stale flag

### 4.2 N2: per_stock_drivers
- Prompt：股票元信息 + 该股票时段全部新闻摘要（用 token 预算限制为 4k） + 近 30 日价格走势数字摘要
- LLM 输出结构化 `list[PriceDriver]`，走 zod 校验
- 每只股票一次 LLM 调用；并发上限 = 8（避免限流）

### 4.3 N3: embed_corpus
- 嵌入器：bge-m3（中英双语，1024 维）；本地或外部 API 可切换（`EmbeddingPort`）
- 嵌入对象：每条新闻的 (title + summary)；每条 PriceDriver 的 summary
- 结果存内存（任务级），不持久化（v1 决策——下次任务重算）

### 4.4 N4: cluster_themes
- 算法：HDBSCAN（`min_cluster_size = 3`，`min_samples = 2`）
- 输入：N3 全部 embedding
- 输出：簇 ID → 成员索引；噪声点单独处理（v1 丢弃，v2 二次聚类）

### 4.5 N5: name_themes
- 对每个簇，LLM 输入：簇内全部新闻摘要的 top-K → 输出 `theme_label + summary + trend`
- `heat_score` = `sum(新闻数 * exp(-days_ago/7)) * mean(成员股票近 5 日涨幅)`
- 涉及成员股票的行业分布 → `related_industries`

### 4.6 N6: market_synth
- 输入：全部 ThemeCluster（按 heat_score 排序的 Top 10）+ 每只股票的 PriceDriver 聚合 + 大盘指数近 30 日表现
- LLM 输出：
  - `style`：当前市场风格信号
  - `long_term_support`：每个热点主题对应的中长期基本面支撑论据 + 风险因子
  - `caveats`：信息覆盖率不足的声明

## 5. 端口

```python
class EmbeddingPort(Protocol):
    def embed(self, texts: Sequence[str]) -> np.ndarray: ...   # (n, dim)

class LLMPort(Protocol):
    def chat(self, messages: list[Message], *, schema: type[BaseModel] | None = None) -> Any: ...
    # schema 不为空时强制结构化输出，失败重试
```

详见 `docs/integrations/llm-providers.md`。

## 6. NestJS HTTP API

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/sentiment/analyze` | `{ codes: string[], days: number }` | `{ task_id }` |
| GET | `/api/sentiment/tasks/:id` | — | `{ status, progress, result?: MarketView }` |
| GET | `/api/sentiment/tasks/:id/stream` | — | SSE：节点级进度 + 部分结果 |

## 7. 性能预算

| 输入规模 | 预算 |
|---|---|
| 50 只股票 / 30 天 | 完整分析 < 3 min（瓶颈在 LLM） |
| LLM 调用次数 | 50（per-stock）+ K（per-theme）+ 1（market）= ~60 次 |
| 总 token | < 200k input + < 30k output |

成本控制：
- 主路 LLM 用 sonnet 等中档模型；market_synth 用 opus
- 同一 (codes, days, asof) 命中结果缓存 30 分钟

## 8. 测试要求

### 8.1 unit（pure 部分）
- `heat_score` 计算
- LangGraph state reducer
- 结构化输出的 schema 校验

### 8.2 integration
- 录制 LLM 输出（vcr 风格 fixture），跑完整 graph，断言三层输出 schema 合法 + 引用链路完整

### 8.3 LLM 行为测试（独立标记，不进默认 CI）
- 用真实 LLM 跑一组 golden 输入 → 人工评估
- 看主观指标：主题命名贴切度、风格判断与同期市场观点一致度

## 9. 风险与备注

- **可解释性 > 准确性**：所有结论必须带 evidence。无 evidence 的结论一律不展示
- **避免过度自信**：LLM 输出必须有 `confidence` 字段，UI 展示低于 0.5 的结论标灰
- **数据不足**：股票池新闻 < 10 条时，跳过 N3~N5，直接给个股层 + warning
- **信息回声**：多个新闻可能转载同一事件，N3 嵌入聚类自带去重；簇内只展示 top 3 evidence
- **不构成投资建议**：所有 UI 输出页脚强制声明，避免合规风险
