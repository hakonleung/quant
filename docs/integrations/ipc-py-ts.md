# 集成 — Python ↔ NestJS 通信（ipc-py-ts）

## 1. 目标

降低跨进程通信成本，避免大数据集（K 线、新闻、筛选结果）的 JSON 序列化/反序列化损耗。**核心选择：Apache Arrow Flight (gRPC) 用于数据面 + protobuf 用于控制面。**

## 2. 通信通道矩阵

| 场景 | 通道 | 编码 |
|---|---|---|
| 短控制调用（< 1MB 结果） | gRPC unary | protobuf |
| 大数据集查询（K 线、新闻列表、筛选结果） | Arrow Flight DoGet | Arrow IPC（列存零拷贝） |
| 客户端推数据（少见） | Arrow Flight DoPut | Arrow IPC |
| 长任务进度流 | gRPC server-streaming | protobuf（小消息，不传数据） |
| NestJS → Web | HTTP/JSON / SSE | JSON |

> **不用** WebSocket / 共享内存 / Plasma：复杂度高、调试困难，Arrow Flight 已能解决主要问题。共享内存是 v3 的优化项（详见 `rfcs/0003-memory-and-ipc.md`）。

## 3. 服务定义（proto 单一源）

```
proto/
├── messages/
│   ├── common.proto                 # TraceContext, Pagination, etc.
│   ├── stock_meta.proto
│   ├── kline.proto
│   ├── screen.proto
│   ├── pattern.proto
│   ├── news.proto
│   └── sentiment.proto
├── schemas/
│   └── arrow/                       # pyarrow.Schema 的 Python 定义文件
│       ├── kline.py
│       ├── news.py
│       └── ...
├── services/
│   └── quant.proto                  # 所有 RPC 入口
├── errors.proto
└── codegen/
    ├── ts_zod.py                    # 从 .proto + arrow schema 生成 TS zod + 类型
    └── py_pydantic.py               # 生成 pydantic 模型
```

`quant.proto` 例：

```proto
service QuantCompute {
  // 控制面
  rpc TranslateNlToDsl(TranslateRequest) returns (TranslateResponse);
  rpc StartScreen(ScreenRequest) returns (TaskHandle);
  rpc StartPatternMatch(PatternRequest) returns (TaskHandle);
  rpc StartSentimentAnalysis(SentimentRequest) returns (TaskHandle);
  rpc GetTaskStatus(TaskHandle) returns (TaskStatus);
  rpc StreamTaskProgress(TaskHandle) returns (stream TaskEvent);

  // Arrow Flight 入口走标准 Flight 协议（不在此 service 中重复定义）
}
```

数据面通过 **Flight Descriptor** 约定：

```python
# 取一段 K 线
descriptor = flight.FlightDescriptor.for_command(
    json.dumps({
        "op": "get_kline_universe",
        "codes": ["600519.SH", ...],
        "start": "2026-01-01",
        "end": "2026-05-01",
        "columns": ["close_qfq", "ma20"],
    }).encode()
)
table: pa.Table = client.do_get(client.get_flight_info(descriptor).endpoints[0].ticket).read_all()
```

## 4. 错误码表

`proto/errors.proto`：

```proto
enum ErrorCode {
  OK = 0;
  INVALID_ARGUMENT = 1;
  NOT_FOUND = 2;
  STOCK_NOT_FOUND = 100;
  META_STALE = 101;
  KLINE_DATA_MISSING = 102;
  DSL_INVALID = 200;
  NL_TRANSLATION_FAILED = 201;
  EVALUATION_FAILED = 202;
  UNIVERSE_TOO_LARGE = 203;
  PATTERN_REFERENCE_LOOKAHEAD = 300;
  SOURCE_UNAVAILABLE = 400;
  RATE_LIMITED = 401;
  LLM_FAILED = 500;
  CACHE_CORRUPTED = 600;
  INTERNAL = 999;
}

message Error {
  ErrorCode code = 1;
  string message = 2;
  string trace_id = 3;
  google.protobuf.Struct details = 4;
}
```

两侧（Python、TS）各自从此 proto 生成枚举和异常类，通过代码生成器保证不漂移。

NestJS 全局异常过滤器：把 gRPC 错误的 `code` → HTTP status：

| ErrorCode 区间 | HTTP |
|---|---|
| 100~199（资源/数据） | 404 / 503 |
| 200~299（DSL/参数） | 400 |
| 400~499（外部源） | 502 / 503 |
| 500~599（LLM） | 502 |
| 600~（内部） | 500 |

## 5. trace_id 透传

- NestJS 入口（`TraceMiddleware`）生成 `trace_id`（uuid v7），写入 gRPC metadata `x-trace-id`
- Python `quant_rpc/server.py` 读 metadata，绑定到日志 contextvar
- 全链路日志携带；前端报错页显示 `trace_id` 便于报错查日志

## 6. 长任务模式

```
1. Web POST /api/screen/run
2. NestJS 调 StartScreen(...) → Python 立即返回 TaskHandle{ task_id }
3. NestJS 把 task_id 透出给前端
4. 前端 GET /api/tasks/:id/stream（SSE）
   ↓ NestJS open
5. NestJS 调 Python StreamTaskProgress(task_id)（gRPC stream）
6. Python 每个 LangGraph 节点完成时 push TaskEvent { node, status, progress, partial_result_url? }
7. 完成事件 partial_result_url 指向 Arrow Flight ticket，前端按需下载
```

任务状态持久化（`KeyValueStore`），断 SSE 重连可续。

## 7. NestJS 侧封装

```ts
// apps/api/src/adapters/quant-compute.adapter.ts
@Injectable()
export class QuantComputeAdapter implements QuantComputePort {
  constructor(
    @Inject(QUANT_GRPC_CLIENT) private readonly grpc: QuantComputeServiceClient,
    @Inject(ARROW_FLIGHT_CLIENT) private readonly flight: FlightClient,
    private readonly logger: Logger,
  ) {}

  async getKlineUniverse(req: GetKlineUniverseRequest): Promise<arrow.Table> {
    // ...
  }

  async startScreen(req: ScreenRequest): Promise<TaskHandle> {
    // ...
  }
}
```

业务 service 只依赖 `QuantComputePort`（接口），不知 gRPC / Flight 的存在。便于测试用 fake 注入。

## 8. Arrow → JSON 转换（仅小结果）

在 NestJS 出口处把 Arrow Table 转 JSON（< 5000 行）：

```ts
function arrowTableToJson(table: arrow.Table): unknown[] {
  return table.toArray().map(row => row.toJSON());
}
```

> 大结果集**不**转 JSON：直接把 Flight ticket 转给前端，前端通过 NestJS 代理或直接（同源）走 Flight。v1 保守起见走 NestJS 代理（避免前端依赖 Flight 客户端）。

## 9. 版本与兼容

- `proto/` 全部文件加 `version: x.y.z` 头
- 字段变更规则：
  - `+ optional field` → minor
  - `+ enum value` → minor
  - `- field` / `rename field` → major（必须双写期 + 迁移文档）
- 启动时双侧握手：客户端发自己的 proto 版本，服务端不兼容时拒绝
- 契约测试：`tests/contract/proto_compat.py` 比较生成代码与上一个发布版本的字段集，diff 必须经人工 approve

## 10. 性能预算

| 操作 | 预算 |
|---|---|
| gRPC unary RTT（同机） | < 5ms |
| Arrow Flight 1MB 列存 | < 30ms（含序列化） |
| Arrow Flight 100MB | < 800ms |
| Stream event RTT | < 50ms |

对比 JSON：100MB Arrow ≈ 800ms，同等 JSON ≈ 6s + 大量 GC。

## 11. 测试要求

### 11.1 unit
- TS 侧：mock gRPC client，断言 service 正确调端口
- Python 侧：fake repository → server handler 断言响应正确

### 11.2 contract（关键）
- 启动 Python server + NestJS（test container）
- 跑 ~30 个端到端用例，覆盖每个 RPC、每种错误码
- proto schema 变更时此测试必须通过

### 11.3 性能基准（不进默认 CI）
- 1MB / 10MB / 100MB Arrow 传输延迟
- 1000 次 gRPC unary 的吞吐
- 跑前后比较，回归则失败

## 12. 风险与备注

- gRPC 在 Node 侧用 `@grpc/grpc-js`（纯 JS）；Arrow Flight 用 `apache-arrow` + 自实现 client（v1）或等官方 JS client 成熟（v2）。**v1 备选**：NestJS 收 Arrow Flight 后直接转 binary 给前端，前端用 `apache-arrow` 解；这样不需要 Node Flight client。
- proto 代码生成必须进 CI（任何 proto 改动 → 必须重新生成 + commit），否则两侧漂移
- gRPC 默认 4MB 消息上限，必须显式调到 64MB（控制面）/ 不限（Flight 走 stream，不受此限）
- v1 不上 mTLS（本机）；v2 上云时启用
