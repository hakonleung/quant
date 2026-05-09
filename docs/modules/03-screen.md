# Screen — 选股筛选 (DSL + NL2DSL)

## 功能

- **DSL**：JSON AST 表达"近 5 日股价均高于 ma5"这类条件；支持比较 / 聚合 / 集合运算（union / intersect / except）。
- **NL2DSL**：自然语言 → DSL 翻译，单轮 LLM + 重试。
- **执行**：在已落库的前复权 K 线上 polars 求值，返回命中代码 + 证据列。

## 实现

| 层                     | 位置                                                                                                 | 说明                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Types                  | `quant_core/domain/types/screen.py`、`packages/shared/src/types/nl-screen.ts`                        | AST 节点（Predicate / Compare / Aggregate / Set）                                                             |
| Parse / Compile / Eval | `quant_core/domain/rules/screen_parse.py`、`screen_compile.py`、`screen_eval.py`                     | 纯函数，无 IO                                                                                                 |
| Universe               | `quant_core/domain/rules/universe_parse.py`、`services/universe_screen_service.py`                   | 宇宙过滤（剔除 ST / 北交所 / 停牌）                                                                           |
| Pipeline               | `quant_core/services/screening_pipeline.py`                                                          | 多阶段编排                                                                                                    |
| Execute                | `quant_core/services/screen_service.py`                                                              | 读 K 线 → 求值 → RecordBatch                                                                                  |
| NL2DSL                 | `apps/api/src/modules/screen/nl-to-dsl.service.ts` + `prompts/nl-to-dsl.prompt.ts` + `op-to-kind.ts` | NestJS 调 `LlmService.completeJson(scope='screen')`；op-tagged → kind-tagged 校验；单次重试。Python `nl_to_dsl_service` 已弃用 |
| RPC                    | `quant_rpc/ops/screen_ops.py`（`screen_run`）；`nl_to_dsl` / `nl_screen` 已弃用待清理               | NL→DSL 不再走 Flight；只有 ScreenPlan 执行下沉到 Python                                                       |
| API                    | `apps/api/src/modules/screen/`（含 `@CurrentUser` 用于 LLM ledger 计费）                            | `POST /api/screen/nl2dsl`（NL→DSL）、`POST /api/screen/run`（执行 DSL）、`POST /api/screen/nl`（合并）       |
| Web                    | `feat-scr-nl`（自然语言入口）、`feat-scr-dsl`（DSL 编辑器） + `app/api/screen/{nl2dsl,run}/route.ts` | BFF 双路代理；编辑后的 plan 重跑可跳过 LLM                                                                    |

## DSL 规约

详见 [`docs/rfcs/0001-screening-dsl.md`](../rfcs/0001-screening-dsl.md)（仍为权威）。变更走 schema 版本号，向后兼容看 `screen_compile.validate()`。

## 缓存策略

- **K 线读取**：DuckDB 列裁剪，命中股票宇宙的列子集，单次扫描。
- **NL2DSL**：不缓存（同一句话不同上下文也可能差异）。LLM 调用结构化失败 → 单次重试再抛 `NL_TRANSLATION_FAILED` / `DSL_INVALID`。`/screen` spec 标 `costsCredits=true`，被 `/agent` 提议时会触发二次确认。
- **结果**：不持久化。前端用 react-query cache 维持会话内可见。
