# RFC 0001 — 股票筛选 DSL

| Status     | Draft      |
| ---------- | ---------- |
| Author     | (待补)     |
| Date       | 2026-05-01 |
| Supersedes | —          |

## 1. 动机

筛选模块需要一个**机器可生成、人可读、可校验、可向量化执行**的中间表达。直接执行自然语言不可控，直接生成 SQL/Polars 表达式难以校验且把执行细节暴露给 LLM。引入 JSON-AST DSL 作为唯一中间层。

## 2. 设计目标

1. **可校验**：每个 AST 节点有 schema，校验失败明确报错
2. **可解释**：UI 可展示每个节点 + 命中证据
3. **可向量化执行**：能编译成 Polars / DuckDB 表达式，单条件全市场 < 2s
4. **可组合**：节点可任意嵌套，支持 `and/or/not`，结果集支持 `intersect/union/except`
5. **可扩展**：新指标/聚合函数加节点类型即可，不需要重写 parser
6. **NL 友好**：LLM 容易生成、容易反翻译为人话给用户看

## 3. 节点分类

```
Plan          := { "asof": date, "expr": Predicate }      // 顶层；asof 必填
Predicate     := Logical | Compare | WindowAssertion
Logical       := { "op": "and" | "or" | "not", "args": [Predicate, ...] }
Compare       := { "op": "gt" | "lt" | "gte" | "lte" | "eq" | "neq",
                   "left": Scalar, "right": Scalar }
WindowAssertion := ForAll | Exists | Consecutive
ForAll        := { "op": "for_all", "window": Window, "predicate": Predicate }
Exists        := { "op": "exists",  "window": Window, "predicate": Predicate }
Consecutive   := { "op": "consecutive", "min_len": int, "predicate": Predicate }

Scalar        := Field | Indicator | Aggregate | PeriodReturn | Const
Field         := { "field": "close" | "close_qfq" | "ma5" | "ma10" | "ma20" | "ma60"
                          | "open" | "high" | "low" | "open_qfq" | "high_qfq" | "low_qfq"
                          | "volume" | "amount" | "turnover_rate" | "pct_chg_qfq" }
Indicator     := { "indicator": "ma", "field": Field-name, "period": int }   // v1 仅支持 ma
Aggregate     := { "agg": "mean" | "sum" | "min" | "max" | "count",
                   "field": Field-name, "window": Window }
PeriodReturn  := { "period_return": Window }                                  // (close_qfq[t] - close_qfq[t-N]) / close_qfq[t-N]
Const         := { "const": number }

Window        := { "days": int }   // v1 只按交易日；v2 加 "calendar_days"
```

## 4. 语义

### 4.1 Asof

- `asof = D` 表示"截至 D 收盘后"
- 所有 `Window {days: N}` 指 `[D-N+1, D]`，含 N 个**交易日**（停牌日不计）

### 4.2 Field

- 引用预计算列，零计算成本

### 4.3 Indicator (v1 仅 `ma`)

- `{indicator: "ma", field: "close_qfq", period: 5}` 等价于直接引用 `Field("ma5")`，但允许任意 period（非 5/10/20/60 时运行时计算）
- v1 优先识别"标准周期"映射到预计算列，命中率 ~95%
- 非标准周期走运行时计算，速度变慢一档（仍可接受，因为已列裁剪）

### 4.4 Aggregate

- `{agg: "mean", field: "turnover_rate", window: {days: 10}}` = 最近 10 个交易日 `turnover_rate` 的算术平均
- `count` 在 `field` 上等价 = 该字段非 null 的数量

### 4.5 PeriodReturn

- `{period_return: {days: 20}}` = `(close_qfq[asof] - close_qfq[asof - 20]) / close_qfq[asof - 20]`
- 起点不存在（停牌、新股） → 整体返回 false（不抛错）

### 4.6 Compare

- 双侧 Scalar；类型不匹配 → 校验期错（不在执行期）

### 4.7 ForAll / Exists

- `for_all`：window 内**全部**交易日的 predicate 为 true
- `exists`：window 内**至少一日** predicate 为 true
- window 内交易日不足 N 时 → 整体 false

### 4.8 Consecutive

- 找最长一段连续真值；`min_len` = 要求最短长度
- 例：`consecutive(min_len=5, predicate=pct_chg_qfq > 0.02)` = "存在连续 5+ 个交易日每日涨幅 > 2%"

### 4.9 Logical

- `not` 只接 1 个 arg
- 短路求值实现细节由编译器决定，不影响语义
- 命名约定：DSL 中所有 `op` 字段值统一**全小写**（包括 `and / or / not / intersect / union / except / for_all / gt / mean / ...`）

## 5. 集合运算（在结果层）

```
ScreenSet     := SingleResult | SetOp
SetOp         := { "op": "intersect" | "union" | "except", "args": [ScreenSet, ...] }
SingleResult  := { "name": str, "result": ScreenResult }
```

集合运算**不下推**到 Plan 层；保留每个 Plan 的独立结果便于审计。

## 6. 校验

```python
class ScreenPlan(BaseModel):
    asof: date
    expr: Predicate

# pydantic 递归 model + discriminator 区分 op
```

校验失败抛 `DSLInvalid(code: str, path: str, message: str)`。`path` 用 JSON Pointer，便于 UI 高亮错误位置。

## 7. 编译到 Polars

```python
# quant_compute/screen/compile.py
def compile_predicate(pred: Predicate, ctx: CompileCtx) -> pl.Expr: ...
```

编译期收集：

- `required_columns: set[str]`（用于列裁剪）
- `required_window_days: int`（最大 window）
- `required_lookback: int`（period_return / consecutive 的回看深度）
- `nonstandard_indicators: list[Indicator]`（需要运行时算）

执行期：

1. `KlineRepo.get_universe_slice(codes, asof - window, asof, columns=required_columns)`
2. 转 LazyFrame，按 `code` group_by
3. 对每只股票 apply 编译后的表达式
4. filter true 的 → 返回 (code, evidence)

## 8. 命中证据（Evidence）

每个匹配返回的不只是 `code`，还有"为什么匹配"：

```python
@dataclass(frozen=True, slots=True)
class ScreenMatch:
    code: str
    evidence: dict[str, JSONValue]
```

示例（"最近5天每天 close_qfq > ma5"）：

```json
{
  "code": "600519",
  "evidence": {
    "matched_op": "for_all",
    "window": ["2026-04-25", "2026-04-29"],
    "values": [
      { "date": "2026-04-25", "close_qfq": 1700.0, "ma5": 1680.5 },
      ...
    ]
  }
}
```

编译器在每个节点附加"证据收集器"：通用规则 = 把 predicate 涉及的字段在 window 内的值都带回。

## 9. NL → DSL 翻译

LLM 单工具：

```python
emit_dsl(plan: ScreenPlan)
```

提示词组成（顺序固定）：

```
You translate Chinese stock-screening queries into a JSON DSL.
Strict rules:
1. Every plan must include "asof" (use today by default).
2. Use "close_qfq" by default for prices; only use "close" if user explicitly says "raw price" / "不复权".
3. Prefer existing precomputed indicators (ma5/10/20/60) over the generic "indicator" node.
4. Window unit is trading days.
5. If query is ambiguous (e.g., "最近"无明确天数), default to 5 days for short / 20 for long; mark warning.

Schema (JSON):
<schema dump>

Examples:
[Q] 最近5天每天股价都高于ma5
[A] { ... }
[Q] 最近10天平均换手率小于10%
[A] { ... }
... (5+ examples, including tricky ones)

Now translate:
[Q] {user query}
```

输出走 `ScreenPlan` pydantic 校验；失败 → 一次重试（带错误反馈）→ 仍失败 → 人工修。

## 10. 反翻译（DSL → 自然语言）

供 UI 展示用："你的条件等价于：最近 5 个交易日每天前复权收盘价都高于 5 日均线"。

走规则模板（不调 LLM，确定性、零成本）：

```python
def explain(node: Predicate) -> str: ...
# pattern matching on op
```

## 11. 性能

| 表达式                               | 列裁剪后         | 全市场预算 |
| ------------------------------------ | ---------------- | ---------- |
| 单 ForAll(window=5, close_qfq > ma5) | 2 列             | < 1s       |
| 4 个条件 intersect                   | 4~6 列           | < 5s       |
| 含 nonstandard indicator             | +运行时算 1~2 列 | < 3s       |

## 12. 缓存键

```
plan_signature = sha256(canonical_json(plan))
universe_signature = sha256(sorted(codes).join(","))
cache_key = f"screen:{plan_signature}:{universe_signature}"
```

asof 作为 plan 字段一部分，自然进 plan_signature。

## 13. v1 不在范围

- 跨股票字段（如"行业内涨幅排名前 10%"）—— v1.5 引入"窗口 over 行业"
- 横截面 z-score（如"PE 在全市场 50 分位以下"）—— 同上
- 财报字段 —— v2
- 时间窗口对齐"自然日 vs 交易日"切换 —— v2

## 14. 已决策事项 / 待办

- ✅ **`asof` 责任**：必须由**前端**在调用前转成绝对 ISO date（YYYY-MM-DD）。后端 / Python 收到的 plan 中 `asof` **必须是绝对日期**；任何相对时间表达（"今天"/"今日"/"yesterday"）一律拒绝以防缓存键漂移
- 是否允许用户保存常用 plan 为模板？建议 v1 实现，存 `data/_user/templates/`
