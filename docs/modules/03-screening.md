# 模块 03 — 股票筛选（screening）

## 1. 职责

将自然语言或手写 DSL 翻译为可执行计划，在全市场日线数据上向量化执行，返回命中股票 + 命中证据。

详细 DSL 语法见 `docs/rfcs/0001-screening-dsl.md`。

## 2. 工作流

```
NL query ──► [LLM tool-call: nl_to_dsl] ──► DSL AST (JSON)
                                              │
                                              ▼
                            [DSL validator: zod / pydantic]
                                              │
                                              ▼
                            [DSL → Polars Expr 编译器]
                                              │
                                              ▼
                ┌──── [KlineRepo.get_universe_slice (列裁剪)] ────┐
                │                                                 │
                ▼                                                 ▼
        [Polars LazyFrame 执行]   ──────────►   [结果表 + 命中证据列]
                                                          │
                                                          ▼
                                             [按结果 cache + 返回]
```

## 3. DSL 概念（详见 RFC 0001）

四类原子：

| 类别 | 例 | 说明 |
|---|---|---|
| 字段引用 | `{ "field": "close_qfq" }` | 直接引用预计算列 |
| 指标 | `{ "indicator": "ma", "field": "close_qfq", "period": 5 }` | v1 仅支持已预计算的 `ma5/10/20/60`，其它指标按需扩展 |
| 窗口聚合 | `{ "agg": "mean", "field": "turnover_rate", "window": {"days": 10} }` | mean / sum / min / max / count |
| 窗口断言 | `{ "op": "for_all", "window": {"days": 5}, "predicate": ... }` | for_all / exists / consecutive |

组合：`and` / `or` / `not`（DSL 中所有 op 字段统一全小写）。

四个用户示例都能表达：

```jsonc
// "最近5天每天股价都高于ma5"
{
  "op": "for_all",
  "window": { "days": 5 },
  "predicate": {
    "op": "gt",
    "left":  { "field": "close_qfq" },
    "right": { "field": "ma5" }
  }
}

// "最近10天平均换手率小于10%"
{
  "op": "lt",
  "left":  { "agg": "mean", "field": "turnover_rate", "window": { "days": 10 } },
  "right": { "const": 0.10 }
}

// "最近20天涨幅大于30%"
{
  "op": "gt",
  "left":  { "period_return": { "days": 20 } },
  "right": { "const": 0.30 }
}

// "连续5天每天涨幅大于2%"
{
  "op": "for_all",
  "window": { "days": 5 },
  "predicate": {
    "op": "gt",
    "left":  { "field": "pct_chg_qfq" },
    "right": { "const": 0.02 }
  }
}
```

## 4. 集合操作

每个 DSL 表达式产出一个候选股票集合（含证据）。系统支持把多个 DSL 结果做：
- `intersect`（与）
- `union`（或）
- `except`（差）

集合操作在结果层（不下推到 Polars 表达式），便于审计 / 可视化每段条件单独的命中。

```jsonc
{
  "op": "intersect",
  "args": [
    { "name": "条件A", "dsl": { ... } },
    { "name": "条件B", "dsl": { ... } }
  ]
}
```

## 5. 端口与执行引擎

```python
# ports/screen_engine.py
class ScreenEngine(Protocol):
    def execute(self, plan: ScreenPlan, universe: Sequence[str], asof: date) -> ScreenResult: ...

# domain/types/screen.py
@dataclass(frozen=True, slots=True)
class ScreenResult:
    asof: date
    matches: list[ScreenMatch]   # 命中股票
    plan_signature: str          # 用于缓存键

@dataclass(frozen=True, slots=True)
class ScreenMatch:
    code: str
    evidence: dict[str, Any]     # { "ma5_at_t-1": 12.3, "close_at_t-1": 12.5, ... }
```

**v1 实现**：`PolarsScreenEngine`（`quant_compute/screen/polars_engine.py`）

```
1. 收集 plan 引用的全部字段 → 列裁剪集合
2. 计算需要的最小窗口 = max(plan 引用的 window_days, 60 for ma60 已存) + buffer
3. KlineRepo.get_universe_slice(codes, asof - max_window, asof, columns) -> Arrow Table
4. Polars LazyFrame 转换：
   - 按 code group_by
   - 应用编译后的 Expr
5. collect 结果，附加 evidence 列
```

## 6. NL → DSL 翻译

走 LLM tool-calling，单一工具 `emit_dsl(plan: object)`。

提示词分三块：
1. **DSL schema**（机器可读，附短描述）
2. **few-shot 示例**：覆盖 §3 的四个示例 + 5 个边界例
3. **用户输入**

输出走 zod / pydantic 校验 → 失败重试一次（携带错误反馈）→ 仍失败 → 返回 `NL_TRANSLATION_FAILED`，前端显示原始 NL + 模板填空让用户修正。

**所有 NL 翻译结果对用户可见可编辑**——这是产品要求，也是减少 LLM 幻觉影响的护栏。

## 7. 执行性能

| 场景 | 预算 |
|---|---|
| 单条件，全市场 | < 2s |
| 10 条件 intersect，全市场 | < 10s |
| 仅读已预计算列（如 `close_qfq, ma5`），跳过指标计算 | < 1s |

优化点：
- **列裁剪**：plan 编译期算出最小列集
- **window 收缩**：plan 编译期算出最小日期窗口
- **DuckDB 加速 universe slice**：`get_universe_slice` 用 DuckDB 扫 Parquet
- **结果缓存**：`(plan_signature, asof, universe_signature)` → ScreenResult 缓存（v1 内存 LRU，v2 Redis）

## 8. NestJS HTTP API

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/screen/translate` | `{ nl_query }` | `{ dsl: ScreenPlan, warnings: [] }` |
| POST | `/api/screen/run` | `{ plan: ScreenPlan, universe?: string[], asof?: date }` | 短任务：`ScreenResult`；长任务：`{ task_id }` |
| POST | `/api/screen/combine` | `{ op: "intersect" \| "union" \| "except", args: ScreenResult[] }` | `ScreenResult` |
| GET | `/api/screen/cache/:signature` | — | `ScreenResult` 或 404 |

错误：`DSL_INVALID` / `NL_TRANSLATION_FAILED` / `EVALUATION_FAILED` / `UNIVERSE_TOO_LARGE`。

## 9. 前端交互（详见 `07-frontend.md`）

- 输入框（NL）+ JSON 编辑器（DSL）双向同步
- 结果表：股票 / 行业 / 当日价 / 命中证据可展开
- "添加另一个条件"按钮触发集合操作 UI

## 10. 测试要求

### 10.1 unit（domain & 编译器，零 mock）
- DSL 校验：每种 op、每种类型错误 → 抛对应异常
- DSL → Polars Expr 编译：四个示例 + 边界（嵌套、空 args、未知 field）
- evidence 提取：从 LazyFrame 结果反查证据值

### 10.2 integration
- 用真实 ParquetKlineRepo + 固定 sample 数据 → 跑四个示例 → 命中股票与证据值断言
- intersect/union/except 集合运算

### 10.3 LLM 翻译测试
- 用录制 + 回放（vcr 风格）固定 LLM 输出，避免 CI 真实调 LLM
- 至少 20 个真实用户问句样本，断言翻译正确率 ≥ 90%

## 11. 风险与备注

- **`asof` 必须由前端转成绝对 ISO date**（YYYY-MM-DD）。后端收到任何相对时间表达式（"今天"等）一律 `DSL_INVALID` 拒绝，避免缓存键漂移
- LLM 可能产出包含 v1 不支持的指标（如"RSI"）→ 校验器拒绝，提示用户用支持的指标，或在 v2 扩展
- 单只股票数据缺失（停牌）不应抛错，按"该日不参与窗口"处理（窗口内有效行 < window_size 时整体判 false 而非异常）
