# IPC — Python ↔ NestJS (Arrow Flight)

## 用途

- NestJS 调 Python 跑筛选 / 形态 / 舆情 / K 线读写。
- 大数据集（K 线、命中表）走列存零拷贝；控制平面走 protobuf-like 错误码。

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

## 操作清单（`quant_rpc/ops/`）

| op | 入参 | 出参 |
| -- | ---- | ---- |
| `nl_to_dsl` | `{nl_query, context}` | `ScreenPlan` JSON（仅翻译，不执行） |
| `screen_run` | `ScreenPlan` JSON | RecordBatch（命中股 + 证据列） |
| `nl_screen` *(legacy)* | `{nl_query, context}` | `ScreenPlan` + 命中（一次调用走完两步，保留兼容） |
| `find_similar` | `{anchor_code, window, top_k}` | RecordBatch（top-k，**始终全宇宙**） |
| `kline.read` | `{code, range}` | RecordBatch（OHLCV + qfq + ma） |
| `kline.sync` | `{codes[], force?}` | `{updated, skipped, errors}` |
| `stock_meta.list` / `.search` / `.sync` | … | … |
| `sentiment.stock` / `.market` | `{code(s)}` | StockSentiment / MarketSentiment |
| `watch.quotes` / `.refresh` | `{universe_id}` | RecordBatch + hits |

## 错误契约

- 单一源：`proto/errors.json`。
- 生成器：`proto/codegen/gen_py_errors.py` → Python `QuantError` 子类；`gen_ts_errors.ts` → TS 错误类 + zod。
- Flight 异常 → `flight_descriptor` 携带 `code / message / details / trace_id`；TS 侧 `packages/shared/src/rpc/flight-error.ts` 解码还原。
- **手写 schema 一律拒收**——必须从 errors.json 生成。

## 调用规约

- 大数据集（>1MB）必须 Flight，不要塞 JSON。
- 频繁小调用必须批量化（一次传一组 code，不要 N 次循环调）。
- 长任务（>2s）返回 `task_id`，由 NestJS 编排 SSE / 轮询。
- 入口生成 `trace_id`，写入 Flight middleware 透传到 Python 日志。
