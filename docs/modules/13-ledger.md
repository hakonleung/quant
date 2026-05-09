# Ledger — 个人盈亏账本

## 功能

- 用户手动记录每日盈亏。每条记录字段：
  - `date`（YYYY-MM-DD，唯一）
  - `pnlAmount`（当日盈亏金额，必填，可正负）
  - `closingPosition`（当日收盘后账户净值，**首条必填**、其余可选）
- 最早一条作为派生链的锚点；后续条目 `closingPosition` 缺失时由 `closing_{i-1} + pnlAmount_i` 自动推导。
- 三元组不强校验：`Δclosing − pnlAmount` 视作隐式 `cashFlow`（出入金 / 分红 / 手续费），允许其非零。
- 列表 + 折线（每日 / 累计）+ 导入 / 导出 + AI 复盘（30 日窗口，Kimi Pro 优先）。

## 派生字段（`enrichEntries`）

| 字段                     | 公式                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `derivedClosingPosition` | 用户值优先；缺省时 = `prev.derivedClosing + pnlAmount`            |
| `closingProvided`        | 用户显式录入则 `true`，链式推导则 `false`                         |
| `derivedDailyPct`        | `pnlAmount / prev.derivedClosing × 100`，prev = 0 时返回 `"0"`    |
| `cashFlow`               | `derivedClosing − prev.derivedClosing − pnlAmount`，非零 = 出入金 |

`prev` 的初始值（用于第一条）= `first.closingPosition − first.pnlAmount`，即"开仓前"隐式仓位。

## 实现

| 层      | 位置                                                | 说明                                                                                                |
| ------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Schema  | `packages/shared/src/types/ledger.ts`               | `LedgerEntry` / `LedgerSnapshot` / `EnrichedLedgerEntry` / `LedgerAnalysis`                         |
| FP      | `packages/shared/src/fp/ledger.ts`                  | `validateLedger` / `enrichEntries` / `mergeEntries` + summary helpers（纯函数，零 IO）              |
| Domain  | `services/py/quant_core/domain/types/ledger.py`     | `EnrichedLedgerEntry` / `LedgerAnalysis` 数据类（仅 schema 镜像，已无 LLM 路径）                    |
| Prompt  | `apps/api/src/modules/ledger/prompts/analyze.prompt.ts` | 中文 system + user prompt（CSV 表头 + closing_provided / cash_flow 显式标志）                       |
| Persist | `apps/api/src/modules/ledger/ledger.store.ts`       | `data/_ledger/entries.json`，atomic `tmp+rename` + 1Hz 节流                                         |
| Cache   | `apps/api/src/modules/ledger/ledger-cache.store.ts` | `data/_ledger/ai-cache.json`，键 = SHA-256(最近 30 enriched)                                        |
| Service | `apps/api/src/modules/ledger/ledger.service.ts`     | CRUD + 校验 + 直接调 `LlmService.completeJson(scope='analyze')` + JSON→`LedgerAnalysis` 解码 + 缓存读写。Python `ledger_service` / `analyze_ledger` op 已弃用 |
| API     | `apps/api/src/modules/ledger/ledger.controller.ts`  | REST：list / enriched / create / patch / delete / import / export / analyze (GET cache, POST fresh) |
| BFF     | `apps/web/app/api/ledger/**`                        | Next.js → NestJS 透传（含 `[date]` 动态段、import / export / analyze）                              |
| Hooks   | `apps/web/lib/hooks/use-ledger.ts`                  | react-query 包装：list / enriched / mutations / cached + analyze                                    |
| Web     | `apps/web/components/feat-ledger/`                  | `LDG.MAIN` Feat：summary bar + 三 tab（list / daily / cumulative）+ AI 面板 + 导入/导出             |
| Term    | `packages/terminal/src/commands/ledger.ts`          | `ledger ls / add / rm / analyze`，全局 RevalidateScope `'ledger'`                                   |

## 持久化与 Git

- 主账本 `data/_ledger/entries.json` 与 AI 缓存 `data/_ledger/ai-cache.json` 都落在 `data/_*/` 路径下；按 `.gitignore` 第 `data/_*/` 行**不入版本库**。导入 / 导出按 JSON 文件路径手动迁移。

## 错误码（`proto/errors.json`）

| code                                  | http | 触发                                                                |
| ------------------------------------- | ---- | ------------------------------------------------------------------- |
| `LEDGER_DUPLICATE_DATE`               | 409  | 创建 / 导入同日期记录                                               |
| `LEDGER_FIRST_NEEDS_CLOSING_POSITION` | 409  | 最早条目缺 `closingPosition`（含"删除导致新首条无锚"场景）          |
| `LEDGER_INVALID_ENTRY`                | 400  | 字段语义校验失败（保留位，目前 zod 在 `INVALID_ARGUMENT` 中已覆盖） |

## AI 分析（NestJS `LedgerService.analyze`）

- 选择 LLM：`LlmService` 走 catalog 顺序（默认 `LLM_PROVIDER`，Qwen → DeepSeek → Moonshot），可选 env 覆盖。
- 输入：最近 ≤ 30 条 enriched 条目，CSV 表头 `date,pnl_amount,closing_position,closing_provided,cash_flow,daily_pct`。
- 输出 schema（`LedgerAnalysisSchema`）：`summary` / `operationStyle` / `marketView` / `recommendations[]`（≤5 条），外加 `windowStart` / `windowEnd` / `entryCount` / `provider` / `generatedAt`。
- 缓存：服务端按 enriched payload 的 SHA-256 命中；用户每次编辑 / 删除 / 导入都会改变 hash → 自动失效。
- 计费：每次 LLM 调用写入 `data/users/{userId}/llm-ledger.json`（scope `analyze`），由 `/usr` 汇总。
- `/analyze` spec 标 `costsCredits=true`，被 `/agent` 提议时会触发二次确认。
- 强刷：`POST /api/ledger/analyze {bypassCache:true}` 或 term `ledger analyze --force`。

## 测试

| 层         | 路径                                                                | 覆盖                                                                                        |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| FP         | `packages/shared/src/fp/ledger.test.ts`                             | sort/dedupe/merge/validate/enrich/cashFlow/total*/series*                                   |
| Schema     | `packages/shared/src/types/ledger.test.ts`                          | parse / strict / null vs undefined closing                                                  |
| Store      | `apps/api/test/modules/ledger/ledger.store.spec.ts`                 | load / atomic write / corruption fallback / 锚 + dup 校验                                   |
| Service    | `apps/api/test/modules/ledger/ledger.service.spec.ts`               | create dup → 409 / patch null / remove anchor → 409 / import overwrite / cache hit & bypass |
| Py service | `services/py/tests/unit/quant_core/services/test_ledger_service.py` | prompt 含 closing_provided / fenced JSON / 输出校验五场景 / 建议截断                        |
| Py op      | `services/py/tests/unit/quant_rpc/ops/test_ledger.py`               | camelCase 序列化 / Decimal 解码 / 上限 30 条 / 类型守卫                                     |
| Term       | `packages/terminal/src/actions/registry.test.ts`                    | 20 条动作（含 4 ledger）golden + 写动作 invalidates                                         |
| Web        | `apps/web/__tests__/lib/api/ledger-endpoints.test.ts`               | URL 编码 + 请求体投影（patch/null/import）                                                  |

## Term 命令

- `ledger ls [--limit N]` — 倒序表格输出，列含 `~` 标记表示 closing 是链式推导值
- `ledger add <date> <pnl> [<closing>]` — 首条没填 closing 时服务端会拒绝
- `ledger rm <date>` — 二次确认；如果删除会让新首条没锚则服务端 409
- `ledger analyze [--force]` — 命中缓存即免费；`--force` 走付费 LLM
