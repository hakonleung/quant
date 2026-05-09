# IPC — Python ↔ NestJS (Arrow Flight)

> Flight 调用与用户无关：`userId` 只在 NestJS 进程帧内流转（日志、文件路径、socket room），
> **不**跨 Flight 边界。Python 计算 / LangGraph 服务永远只看到调用方传来的 payload，
> 不持有用户态。鉴权与多用户分区都是 NestJS 层的事。详见 `docs/integrations/auth.md`。

## 用途

- NestJS 调 Python 跑筛选 / 形态 / 舆情 / K 线读写。
- 大数据集（K 线、命中表）走列存零拷贝；控制平面错误用统一错误码表。

## 链路

```
NestJS                                           Python
─────                                            ──────
ArrowFlightClient (apps/api/src/adapters/)  ───> quant_rpc/server.py
  - DoAction(op, params)                          - dispatch handler in ops/
  - DoGet(ticket) → Stream<RecordBatch>
  - DoPut(stream) → Ack
                                                 quant_rpc/ops/<op>.py
                                                   → quant_core.<service>
                                                   → adapters / cache
```

- 端口：`:8815`（默认 Flight）。
- 认证：v1 无（127.0.0.1 监听）。
- 包装：JSON descriptor `{"op":"<name>","args":{...}}`；返回 RecordBatch 或 JSON。

## 操作清单（实际注册名，见 `quant_rpc/ops/*`）

| 模块       | op                                                                              | 说明                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| meta       | `get_stock_meta_batch`                                                          | 按 code 列表取元信息                                                                                                                                                                                                                          |
| meta       | `list_stock_meta_by_industry`                                                   | 按行业列出                                                                                                                                                                                                                                    |
| meta       | `list_stock_meta_all`                                                           | 全宇宙快照                                                                                                                                                                                                                                    |
| meta       | `check_stock_meta_sources`                                                      | 多源可用性探测                                                                                                                                                                                                                                |
| meta       | `sync_stock_meta_full`                                                          | 全量从 akshare 刷新                                                                                                                                                                                                                           |
| meta       | `enrich_stock_meta_for_code`                                                    | 单只补全                                                                                                                                                                                                                                      |
| kline      | `list_kline_for_code`                                                           | 单只最近 N 条                                                                                                                                                                                                                                 |
| kline      | `list_kline_bulk_last_n`                                                        | 批量 / 全宇宙最近 N 条                                                                                                                                                                                                                        |
| kline      | `list_kline_watermarks`                                                         | 各 code 当前最新交易日                                                                                                                                                                                                                        |
| kline      | `sync_kline_for_code`                                                           | 拉取 + 落库                                                                                                                                                                                                                                   |
| kline      | `list_stock_snapshots`                                                          | 5D OHLCV + 元信息                                                                                                                                                                                                                             |
| kline      | `get_latest_trade_day`                                                          | 交易日历                                                                                                                                                                                                                                      |
| financials | `bulk_sync_financials` / `enrich_financials_for_code` / `find_stale_financials` | 财务字段同步 / 巡检                                                                                                                                                                                                                           |
| screen     | `screen_run`                                                                    | 执行 ScreenPlan → 命中 RecordBatch（NL→DSL 在 NestJS，本 op 只接 AST）                                                                                                                                                                       |
| pattern    | `find_similar_patterns`                                                         | DTW + similarity rank（始终全宇宙）                                                                                                                                                                                                           |
| watch      | `watch.quote_one`                                                               | 单只盘中行情（含 `amount` / `volume`）                                                                                                                                                                                                        |
| watch      | `watch.universe_refresh`                                                        | 整组刷新                                                                                                                                                                                                                                      |
| blacklist  | `compute_ashare_blacklist`                                                      | 重算 A 股噪音黑名单（cron 触发）                                                                                                                                                                                                              |

## 错误契约

- 单一源：`proto/errors.json`（28 条，类别区段：data 100–199、dsl 200–299、pattern 300–399、external 400–499、llm 500–599、cache 600–699、999 = INTERNAL）。
- 生成器：`python -m proto.codegen` → `services/py/quant_core/errors_gen.py`（`QuantError` 子类）+ `apps/shared/src/errors/gen.ts`（TS 错误类 + zod）。
- Flight 异常 → `flight_descriptor` 携带 `code / message / details / trace_id`；TS 侧 `packages/shared/src/rpc/flight-error.ts` 解码还原。
- **手写 schema 一律拒收**——必须从 `errors.json` 生成。

## 调用规约

- 大数据集（>1MB）必须 Flight，不要塞 JSON。
- 频繁小调用必须批量化（一次传一组 code，不要 N 次循环调）。
- 长任务（>2s）返回 `task_id`，由 NestJS 编排 SSE / 轮询。
- 入口生成 `trace_id`，写入 Flight middleware 透传到 Python 日志。
