# Screen executor — DuckDB SQL pushdown (Phase 3 plan + baseline)

> Status: **baseline captured**, pushdown not yet implemented.
> Owner: open. Last updated: 2026-05-16.

## 背景与瓶颈定位

Phase 2 把 screen DSL 执行从 Python 搬到 NestJS 进程内（commit `1d5f54d`），实现是一个**直译的 TS 解释器**（`apps/api/src/modules/screen/domain/pure/screen-eval.ts`），算法与原 Python `screen_eval.py` 同构：

- 每只 code 在自己的 `ScreenRow[]` 切片上跑解释器
- `Compare` / `Aggregate` 在 row × 标量节点的双循环中用 `decimal.js` 求值
- `ForAll` / `Exists` / `Consecutive` 递归对子窗口反复求值（最坏 O(days × inner)）

Phase 2 已经消除了 Flight RPC hop，所以剩下的耗时主要是：
1. DuckDB `read_parquet` 拿 universe 切片
2. JS 解释器 + decimal.js 算术

下一步（Phase 3）的目标是把 (2) 大部分下推到 DuckDB 的列式向量化引擎。

## Baseline（实测）

跑 `pnpm --filter @quant/api tsx scripts/bench-screen.ts --runs 10 --warmup 3`，本机 M-series Mac，全市场 5512 个 code，最新 trade date `2026-05-15`：

| Plan                                          | p50 ms | p95 ms | matches |
| --------------------------------------------- | ------ | ------ | ------- |
| `simple-compare (close_qfq > 50)`             | 77.3   | 81.3   | 847     |
| `aggregate (mean(close_qfq, 20) > 30)`        | 268.3  | 268.6  | 1562    |
| `for_all 5d (close_qfq > ma5)`                | 112.5  | 112.7  | 1075    |
| `consecutive 3d (volume > 1e7) + rank top-50` | 260.6  | 269.0  | 50      |

观察：
- 简单 row-level compare 已经 **77 ms**——大头是 DuckDB 读盘（~60 ms 估）+ 解释器（~15 ms）。
- `Aggregate(mean, days=20)` 跳到 268 ms：解释器对每只 code 跑 20-step decimal.js 累加 × 5512 codes ≈ 110k 次 `Decimal.add`。
- `Consecutive(min_len=3)` 是 250 ms，主要因为它对每个 i 都重算 `predicate(rows[:i+1])`——O(n²) 行为。

之前我在对话里估算的 "500 ms – 2 s" 是按 CPython 解释器 + list-of-dict 的口径推的；V8 + 单层数组遍历比那快得多，实际 **解释器并不是性能瓶颈**。这也意味着 Phase 3 SQL 下推的预期收益要重新校准。

## 方案与权衡

### Phase 3 方案 A — DuckDB SQL codegen（推荐）

把 DSL AST → 一条 DuckDB SELECT，让 C++ vectorized engine 干活：

- `Compare(field, op, const)` → row-level WHERE
- `Aggregate(fn, field, days)` → window aggregate (`AVG/SUM/MIN/MAX OVER (PARTITION BY code ORDER BY ts ROWS days-1 PRECEDING)`)
- `PeriodReturn(days)` → `(close_qfq - LAG(close_qfq, days) OVER (...)) / LAG(...)`
- `ForAll(days, pred)` → `MIN(pred_bool) OVER (... ROWS days-1 PRECEDING) = 1` at asof
- `Exists(days, pred)` → `MAX(pred_bool) OVER (...) = 1`
- `Consecutive(min_len, pred)` → 经典 "gaps-and-islands" 模式：用 `SUM(1 - pred_bool) OVER (...)` 作为 streak group key，分组 count

Codegen 量级估计 600–900 LOC TS（含递归 walker、参数绑定、子查询 CTE 组装）。

**预期收益**（基于上面观察重新校准）：
- 简单 compare: 77 ms → ~70 ms（基本不变，已经是读盘 bound）
- aggregate(mean, 20): 268 ms → ~80–120 ms（**2–3× 提升**）
- for_all 5d: 112 ms → ~80 ms（小幅）
- consecutive + rank: 261 ms → ~100–150 ms（**2× 提升**，关键是 O(n²) → O(n)）

整体 **2–3× p95 提升**——远低于我之前对话里说的 5–10×。原因是 V8 解释器比预期高效，所以 SQL 下推真正赚的不是 "CPU 快了"，而是 "复杂窗口预测的 O(n²) → O(n)"。

### Phase 3 方案 B — 把 universe 切片预先 materialise 成单张表

读完 parquet 后塞进一张 DuckDB temp table，让后续每个 plan 共享 cache。适合一个 session 跑多个相关 plan 的场景（比如 NL→DSL 自动重试的场景），但单 plan 场景没收益。优先级低。

### 不做的

- 不要为了 perf 切到 Polars / Arrow Compute；DuckDB 已经是 vectorized + 已经接好 parquet 读取链路，引入第三个引擎纯属累赘。
- 不要把 Decimal 换成 number。CLAUDE.md §2.8 是底线。

## 落地步骤

1. 写 `apps/api/src/modules/screen/domain/pure/screen-sql-codegen.ts`：纯函数 `(plan, rank) → { sql, params }`。
2. 写 `screen-sql-codegen.test.ts`：对每种节点类型断言生成的 SQL 文本（snapshot test 即可），加 invariant test "无论 plan 形态，生成的 SQL 都不引用 plan 外的列名"。
3. 写 `screen-parity.test.ts`：对一组代表性 plan，分别跑 interpreter (`evaluatePredicate`) + codegen (`exec SQL`)，断言 matches 集合相等。这是 Phase 3 安全网。
4. `ScreenExecService.execute` 增加一条 fast path：当 `summarise()` 表明 AST 可被 SQL 下推时走 codegen + 一次 DuckDB query；否则 fall back 到 interpreter。先全部走 fast path，等 parity test 全绿再删 fallback。
5. 重新跑 `bench-screen.ts`，把新数据写到本文档的 "落地后实测" section。
6. 把本文档的 status 改成 "shipped"。

## 落地后实测

（待 Phase 3 完成后填写）

| Plan                                          | baseline p50 / p95 | pushdown p50 / p95 | speedup |
| --------------------------------------------- | ------------------ | ------------------ | ------- |
| `simple-compare (close_qfq > 50)`             | 77.3 / 81.3        | TBD                | TBD     |
| `aggregate (mean(close_qfq, 20) > 30)`        | 268.3 / 268.6      | TBD                | TBD     |
| `for_all 5d (close_qfq > ma5)`                | 112.5 / 112.7      | TBD                | TBD     |
| `consecutive 3d (volume > 1e7) + rank top-50` | 260.6 / 269.0      | TBD                | TBD     |

## 回归风险与监控点

- **数值精度**：DuckDB 用 `DOUBLE`，interpreter 用 `decimal.js`。对所有 `Compare` 的两侧值在 SQL 内 cast 成 `DECIMAL(28, 12)` 求值，否则浮点误差会让阈值附近的 code 抖动。Parity test 必须覆盖 "value 正好命中阈值"、"价格 = 19.99 × shares = 大数" 两种典型场景。
- **NULL 语义**：DSL 的 `_NA → Compare false` 与 SQL 的 `NULL = NULL → NULL` 不一样。codegen 要把 `WHERE ma60 > 10` 翻译成 `WHERE ma60 IS NOT NULL AND ma60 > 10`，否则 NULL 行的处理不一致。
- **plan_signature**：Phase 3 不改 signature 算法，cache key 继续按 Py-parity 的 canonical JSON SHA-256 走，缓存不失效。

## 监控建议

落地后在 `ScreenService.runDsl` 加 timing log（`duration_ms` 字段）。建议阈值告警 `p95 > 1s` —— 真出现这个数说明 codegen 漏了某条 plan 路径走 interpreter fallback 了。
