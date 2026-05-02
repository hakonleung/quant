# 集成 — LangGraph 工作流（workflow-langgraph）

## 1. 目标

用 LangGraph 编排消息面分析（v1 主用例）和未来其它多步任务（如"筛选 → 形态 → 分析"组合流）。强调：状态可见、节点可重试、进度可流式上报、断点可续跑。

## 2. 适用场景

| 场景                           | 是否用 LangGraph     |
| ------------------------------ | -------------------- |
| 消息面分析（多 LLM + 聚类）    | ✅                   |
| 复合任务："筛选 → 形态 → 分析" | ✅（v1.5）           |
| 单次筛选                       | ❌（直接同步执行）   |
| 数据增量更新调度               | ❌（用 apscheduler） |
| 单次形态匹配                   | ❌（直接执行）       |

判断标准：**有 ≥ 2 步、需要持久化进度、可能耗时 > 30s**。

## 2.1 task_id 与 thread_id

业务对外（NestJS / 前端 / API） 一律称 `task_id`；LangGraph 内部用 `thread_id` 作为 checkpoint 主键。两者**一对一**映射：

```python
thread_id = task_id     # v1 直接相等
```

转换发生在 `WorkflowService.start()` 的入口；上层不感知 `thread_id`。

## 3. State 设计

```python
# quant_workflow/sentiment/state.py
from typing import TypedDict, Annotated
from langgraph.graph.message import add_messages

class SentimentState(TypedDict):
    # 输入
    codes: list[str]
    days: int
    asof: date
    trace_id: str

    # N1
    evidence_by_code: dict[str, EvidenceBundle]   # 节点产出后写入

    # N2
    drivers_by_code: dict[str, list[PriceDriver]]

    # N3
    embeddings: NDArray[np.float32] | None
    embed_index_to_source: list[EvidenceRef]

    # N4
    clusters: list[ClusterAssignment]

    # N5
    themes: list[ThemeCluster]

    # N6
    market_view: MarketView | None

    # 元
    errors: list[NodeError]                       # 节点级错误集合
    progress: dict[str, NodeProgress]             # node_name -> { status, started_at, ended_at }
```

**Reducer**：每个节点只**追加/更新自己负责的 key**，不要全量替换 state；用 LangGraph 的 `Annotated[..., reducer]` 表达。

## 3.1 支撑类型（在 `quant_core/domain/types/sentiment_workflow.py`）

```python
@dataclass(frozen=True, slots=True)
class EvidenceBundle:
    """N1 输出：单只股票的原始证据集合。"""
    code: str
    news: list[NewsItem]
    reports: list[ResearchReport]
    summary_token_estimate: int

@dataclass(frozen=True, slots=True)
class EvidenceRef:
    """N3 嵌入索引到原文的反向指针。"""
    source_id: str                          # NewsItem.id 或 ResearchReport.id
    source_type: Literal["news", "report"]
    code: str | None                        # 关联个股（来自驱动因素）；可为 None（来自全局新闻）
    text_offset: int                        # 在拼接文本中的起点（用于回展）

@dataclass(frozen=True, slots=True)
class ClusterAssignment:
    """N4 输出：每个 embedding 索引对应的簇号；噪声为 -1。"""
    embed_index: int
    cluster_id: int

@dataclass(frozen=True, slots=True)
class NodeProgress:
    status: Literal["pending", "running", "done", "failed", "skipped"]
    started_at: datetime | None = None
    ended_at: datetime | None = None
    progress_pct: float = 0.0               # 0~1
    note: str | None = None

@dataclass(frozen=True, slots=True)
class NodeError:
    node: str
    code: str                               # 引用 proto/errors.proto 的 ErrorCode
    message: str
    occurred_at: datetime
```

`StyleSignal` 与 `FundamentalThesis` 等顶层结果类型定义在 `06-sentiment-analysis.md` §2，避免重复。

## 4. Graph 定义

```python
# quant_workflow/sentiment/graph.py
def build_sentiment_graph(deps: SentimentDeps) -> CompiledGraph:
    g = StateGraph(SentimentState)
    g.add_node("gather_evidence",   make_gather_evidence(deps))
    g.add_node("per_stock_drivers", make_per_stock_drivers(deps))
    g.add_node("embed_corpus",      make_embed_corpus(deps))
    g.add_node("cluster_themes",    make_cluster_themes(deps))
    g.add_node("name_themes",       make_name_themes(deps))
    g.add_node("market_synth",      make_market_synth(deps))

    g.set_entry_point("gather_evidence")
    g.add_edge("gather_evidence",   "per_stock_drivers")
    g.add_edge("per_stock_drivers", "embed_corpus")
    g.add_edge("embed_corpus",      "cluster_themes")
    g.add_edge("cluster_themes",    "name_themes")
    g.add_edge("name_themes",       "market_synth")
    g.add_edge("market_synth",      END)

    # 条件分支：embed 后若样本太少（<10），跳过 cluster/name，直接 market_synth 用 driver 兜底
    g.add_conditional_edges(
        "embed_corpus",
        route_after_embed,                      # 纯函数，输入 state，输出下一节点名
        { "continue": "cluster_themes", "skip_to_market": "market_synth" },
    )

    return g.compile(checkpointer=deps.checkpointer)
```

## 5. 依赖注入

不在节点函数内 `import` 任何 adapter，全部通过 `SentimentDeps` 传入：

```python
@dataclass(frozen=True, slots=True)
class SentimentDeps:
    news_repo: NewsRepo
    report_repo: ReportRepo
    llm: LLMPort
    embedder: EmbeddingPort
    checkpointer: Checkpointer
    clock: Clock
    logger: Logger
```

节点工厂模式：

```python
def make_gather_evidence(deps: SentimentDeps) -> Callable[[SentimentState], SentimentState]:
    def node(state: SentimentState) -> SentimentState:
        # 用 deps.news_repo / deps.report_repo
        ...
    return node
```

测试时注入 fake：内存 NewsRepo + 录制 LLM。

## 6. Checkpointer（状态持久化）

```python
# ports/checkpointer.py
class Checkpointer(Protocol):
    def save(self, thread_id: str, state: dict, *, version: int) -> None: ...
    def load(self, thread_id: str) -> tuple[dict, int] | None: ...
```

v1 适配器：`FileCheckpointer`（`data/_checkpoints/<thread_id>.json`）。

每个节点运行前后自动 save。失败 → 下次启动从最后 checkpoint 续跑。

## 7. 节点契约

每个节点函数签名：`(state: TState) -> TState`（部分更新，靠 reducer 合并）。

约束：

- **幂等**：同一 state 多次执行结果一致（因为可能从 checkpoint 重跑）
- **纯化外层**：节点内部副作用必须通过 `deps`；不允许直接调 `requests.get` / `time.sleep`
- **失败抛领域异常**：节点不 catch、不日志吞掉；让 graph runner 决定重试或 fail-fast
- **写 progress**：节点开始/结束时写 `state.progress[node_name]`

```python
def node(state: State) -> State:
    started = deps.clock.now()
    state["progress"][NODE_NAME] = NodeProgress(status="running", started_at=started)
    yield_progress(state)                # 推送 SSE
    try:
        result = do_work(state, deps)
    except QuantError as e:
        state["errors"].append(NodeError(node=NODE_NAME, error=e.code, message=str(e)))
        state["progress"][NODE_NAME] = NodeProgress(status="failed", started_at=started, ended_at=deps.clock.now())
        raise
    state["progress"][NODE_NAME] = NodeProgress(status="done", started_at=started, ended_at=deps.clock.now())
    return { ...state, ...partial_update_from_result(result) }
```

## 8. 进度上报

`yield_progress(state)`：把 progress 写入一个 in-memory pub/sub（`asyncio.Queue` per task），`StreamTaskProgress` gRPC handler 从队列消费推给 NestJS。

队列只存 progress 增量，不存大数据；大数据存进 state（落 checkpoint），客户端按需取。

## 9. 重试策略

LangGraph 节点级重试用 `RetryPolicy`：

```python
g.add_node(
    "per_stock_drivers",
    node_fn,
    retry=NodeRetryPolicy(max_attempts=2, backoff_base_ms=500, retry_on=(LLMTransientError,)),
)
```

不可重试：`DSLInvalid`、`StockNotFound`。
可重试：`LLMTransientError`、`SourceTimeout`。
区分由领域异常类型决定。

## 10. 启动与服务化

```python
# quant_workflow/server.py
class WorkflowService:
    def __init__(self, graphs: dict[str, CompiledGraph], task_repo: TaskRepo) -> None: ...
    def start(self, kind: str, payload: dict, trace_id: str) -> TaskHandle: ...
    def get_status(self, task_id: str) -> TaskStatus: ...
    def stream_progress(self, task_id: str) -> Iterator[TaskEvent]: ...
```

通过 gRPC 暴露给 NestJS（见 `ipc-py-ts.md`）。

## 11. 测试要求

### 11.1 unit

- 节点函数：用 fake deps + 构造 state，断言输出 state 增量
- 路由函数（条件分支）：纯函数，常规 unit

### 11.2 integration

- 全图跑：fake deps（内存 repo + 录制 LLM）→ 完整 state → 断言 final.market_view 结构合法
- 故障恢复：在 N3 注入失败 → 检查 checkpoint → restart → 续跑成功
- 路由：embed 样本 < 10 时走 `skip_to_market`

### 11.3 contract

- progress 事件序列稳定：相同输入输出相同事件流（用 snapshot 测试）

## 12. 风险与备注

- LangGraph 升级速度快，API 可能变更——在 `quant_workflow/_compat.py` 做薄封装，限制在仓库内的扩散
- Checkpoint 文件可能很大（含 embeddings）——v2 切对象存储，state 中只存指针
- 一个 task 的 thread_id 必须**全局唯一且包含 asof**，避免不同日期跑相同输入互相覆盖
