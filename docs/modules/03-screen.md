# Screen — 选股筛选 (DSL + NL2DSL)

## 功能

- **DSL**：JSON AST 表达"近 5 日股价均高于 ma5"这类条件；支持比较 / 聚合 / 集合运算（union / intersect / except）。
- **NL2DSL**：自然语言 → DSL 翻译，单轮 LLM + 重试。
- **执行**：NestJS 进程内对 DuckDB-backed 的前复权 K 线 slice 跑解释器求值，返回命中代码 + 证据列。Python 不再参与 screen 执行。

## 实现

| 层              | 位置                                                                                                 | 说明                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Types           | `packages/shared/src/types/nl-screen.ts`                                                             | AST 节点（DslPredicate / DslScalar / UniverseExpr / ScreenPlanAst），zod schema + 类型同源。前后端 + NestJS 共用。      |
| Field 白名单    | `apps/api/src/modules/screen/domain/pure/screen-fields.ts`                                           | `SCREEN_FIELD_NAMES` / `UNIVERSE_FIELD_NAMES` / op 白名单。NestJS 端唯一真理。                                          |
| Eval            | `apps/api/src/modules/screen/domain/pure/screen-eval.ts`、`universe-eval.ts`                         | 纯解释器；零 IO，零框架依赖；`Decimal.js` 全程不丢精度。                                                                |
| Summarise       | `apps/api/src/modules/screen/domain/pure/screen-summarise.ts`                                        | 走一遍 AST 收集所需列 + lookback bars，驱动 DuckDB 的列投影与时间裁剪。                                                 |
| Plan signature  | `apps/api/src/modules/screen/domain/pure/plan-signature.ts`                                          | 与 Py `screen_service.plan_signature` 字节级一致的 SHA-256（canonical JSON、键排序、无空白），迁移后缓存 key 仍然稳定。 |
| Evidence        | `apps/api/src/modules/screen/domain/pure/screen-evidence.ts`                                         | 每只命中股票的 window + 各 Compare scalar 4dp 量化值，结构与旧 Py 输出一致。                                            |
| Universe filter | `apps/api/src/modules/screen/universe-filter.service.ts`                                             | 从 `LocalStockMetaAdapter` 拉全市场 meta，过 `evaluateUniverse`，返回排序代码列表。                                     |
| Executor        | `apps/api/src/modules/screen/screen-exec.service.ts`                                                 | 编排：summarise → universe 解析 → `KlineReaderService.bulkRangeForScreen` → per-code 解释器 → evidence + rank。         |
| KlineReader     | `apps/api/src/modules/kline/kline-reader.service.ts:bulkRangeForScreen`                              | DuckDB read 后合成 `pct_chg_qfq`；返回 `Record<code, ScreenRow[]>`。                                                    |
| NL2DSL          | `apps/api/src/modules/screen/nl-to-dsl.service.ts` + `prompts/nl-to-dsl.prompt.ts` + `op-to-kind.ts` | NestJS 调 `LlmService.completeJson(scope='screen')` 强制 `response_format=json_object` + 单行 minified；op-tagged → kind-tagged 校验。**不重试**，失败抛 `NL_TRANSLATION_FAILED`。 |
| API             | `apps/api/src/modules/screen/`（含 `@CurrentUser` 用于 LLM ledger 计费）                             | `POST /api/screen/nl2dsl`（NL→DSL）、`POST /api/screen/run`（执行 DSL）、`POST /api/screen/nl`（合并）                  |
| Web             | `feat-scr-nl`（自然语言入口）、`feat-scr-dsl`（DSL 编辑器） + `app/api/screen/{nl2dsl,run}/route.ts` | BFF 双路代理；编辑后的 plan 重跑可跳过 LLM                                                                              |

> 历史背景：v1 时 screen 执行在 Python（`quant_core/services/screen_service.py` + `quant_rpc/ops/screen_ops.py`），通过 `screen_run` Flight op 调度。该 stack 于 storage-unify-rollout 后整体下沉到 NestJS，Python 不再持有 DSL 类型 / 解析 / 求值 / signature 任一环节。

## DSL 规约

详见 [`docs/rfcs/0001-screening-dsl.md`](../rfcs/0001-screening-dsl.md)（仍为权威）。变更走 schema 版本号；NestJS 端校验在 `nl-screen.ts` zod schema 中收口。

## 缓存策略

- **K 线读取**：DuckDB 列裁剪 + 时间窗口；`bulkRangeForScreen` 单次 `read_parquet` 拉满 universe。
- **NL2DSL**：不缓存。LLM 调用结构化失败 → 单次重试再抛 `NL_TRANSLATION_FAILED` / `DSL_INVALID`。`/screen` spec 标 `costsCredits=true`，被 `/agent` 提议时会触发二次确认。
- **结果**：不持久化。前端用 react-query cache 维持会话内可见；`planSignature`（Py-parity）作为 stable cache key。

## 性能与未来工作

当前 TS 解释器与原 Py 解释器同档（同算法移植）；性能收益主要来自移除 Flight hop 和共享进程内 DuckDB 读盘。下一步是 DSL → DuckDB SQL 下推（`Compare` → WHERE，`Aggregate` → 窗口聚合，`ForAll/Exists/Consecutive` → 窗口函数），可在不改 `ScreenService` 公共契约的前提下替换 `ScreenExecService.execute`，预计带来 5–10× 提升。详见 `docs/perf/screen-migration.md`（待落地）。
