# RFC 0003 — 内存管理与跨进程通信优化

| Status | Draft |
|---|---|
| Date | 2026-05-01 |

## 1. 背景

两个相互纠缠的问题：

- **内存爆炸**：A 股 5500 只股票 × 10 年 × 20 列 ≈ 2.2 亿行 × 100 字节 = 22GB raw。如果"先全部加载再筛选"会立即 OOM。
- **跨进程通信开销**：NestJS 调 Python 取数据，如果序列化为 JSON 来回转，100MB 数据要花数秒，且双倍内存占用。

本 RFC 给出**按需加载 + 列存零拷贝**的两栈联合方案。

## 2. 目标

| 指标 | 目标 |
|---|---|
| Python 服务常驻内存 | < 1.5GB（不含正在执行的任务工作集） |
| 单次筛选峰值内存 | < 4GB |
| 单次形态匹配峰值 | < 6GB |
| NestJS 常驻内存 | < 500MB |
| 100MB 列存数据 NestJS↔Python 传输 | < 800ms |

## 3. 内存层级与策略

### 3.1 数据驻留分层

```
┌──────────────────────────────────────────┐
│ L0: 内存（任务工作集，按需）              │  Polars LazyFrame collect 后的当前 batch
├──────────────────────────────────────────┤
│ L1: mmap Parquet（OS page cache）         │  pyarrow.parquet.read_table(..., memory_map=True)
├──────────────────────────────────────────┤
│ L2: 磁盘 Parquet                          │  data/kline/daily/*.parquet
└──────────────────────────────────────────┘
```

- L0 严格受任务作用域控制；任务结束自动 GC
- L1 由 OS 管理；Python 端代码假装"读了 100GB"，实际 OS 按页加载
- 任何模块**禁止**自己维护"全市场常驻 DataFrame"

### 3.2 列裁剪 + 谓词下推（强制）

每次读取：
- 必须传 `columns=[...]`（仅需要的列）
- 必须传 `filters=[...]`（按 code / date 范围下推到 parquet 元数据）

```python
table = pq.read_table(
    "data/kline/daily/600519.SH.parquet",
    columns=["trade_date", "close_qfq", "ma20"],
    filters=[("trade_date", ">=", date(2026, 1, 1))],
    memory_map=True,
)
```

DuckDB 路径同理：`SELECT close_qfq, ma20 FROM kline WHERE code IN (...) AND trade_date >= '2026-01-01'`，DuckDB 自动 pushdown。

### 3.3 流式而非全量

任何"按 entity 处理"的循环用迭代器：

```python
def iter_universe_slice(codes, start, end, *, batch_size=200) -> Iterator[pa.Table]:
    for chunk in batched(codes, batch_size):
        yield repo.get_universe_slice(chunk, start, end, columns=...)
```

调用方：

```python
for batch in iter_universe_slice(codes, start, end, batch_size=200):
    process(batch)              # 此 batch 处理完即可释放
```

**反例（禁止）**：把全部 codes 一次性 collect 到一个超大 DataFrame。

### 3.4 LazyFrame 优先

Polars 推荐 LazyFrame：

```python
lf = (
    pl.scan_parquet("data/kline/daily/*.parquet", n_rows=None)
    .filter(pl.col("trade_date") >= start)
    .group_by("code")
    .agg(...)
)
result = lf.collect(streaming=True)   # 流式聚合，控制峰值内存
```

`streaming=True` 让 Polars 在不能一次装下时分块。

### 3.5 任务隔离

每个长任务独立子进程（v2）：

- v1：单进程内任务，结束后强 GC（`gc.collect()` + Polars `pl.thread_pool().reset()`）
- v2：每个任务 `multiprocessing.spawn` 一个 worker，结束即销毁；OS 回收一切

## 4. 跨进程数据传输

### 4.1 决策树

```
                 数据量？
              ┌─────────┴─────────┐
            < 1MB            ≥ 1MB
              │                  │
           gRPC unary       Arrow Flight DoGet
           (protobuf)       (列存零拷贝)
              │                  │
         ┌────┴────┐          ┌──┴──────────────┐
         │ JSON    │          │ NestJS 直转给前端│
         │ 给前端  │          │ 还是先转 JSON？  │
         └─────────┘          └──┬──────────────┘
                                 │
                 ┌───────────────┴────────────────┐
            <5000 行                            ≥ 5000 行
                 │                                  │
            转 JSON 走 HTTP             保留 Arrow，前端用 apache-arrow JS 解析
                                                    （v1 可选先 JSON，v2 切 Arrow）
```

### 4.2 Arrow Flight 零拷贝

- Python 端：`pa.Table` → Flight server 直接 send（内部走 Arrow IPC，不复制）
- NestJS 端：`apache-arrow` 收到 IPC stream → `Table` 对象，按需访问列（不全量物化）

```ts
// apps/api/src/adapters/arrow-flight.client.ts
async getKlineUniverse(req): Promise<arrow.Table> {
  const stream = this.flight.doGet(ticket);
  const reader = await arrow.RecordBatchReader.from(stream);
  return new arrow.Table(await reader.readAll());
}
```

### 4.3 大结果的"按需取"

- Python 完成筛选后，结果存内存（带 task_id）
- NestJS 调 `GetTaskResult(task_id, offset, limit)` 分页拿
- 整批走 Arrow Flight，不走 JSON

避免一次性把 5000 行 × 100 列推到前端浏览器。

## 5. NestJS ↔ Python 内存共享（v3，先不做）

完整零拷贝（同机）：
- Plasma store / shared memory / Arrow IPC over UNIX domain socket
- 复杂度高，同机部署才有意义

**v1/v2 决策：不做**。Arrow Flight (gRPC) 在同机 loopback 上已经足够快，且能无缝切异地部署。共享内存留作 v3 极致优化备选。

## 6. NestJS 自身的内存策略

- 不缓存大数据；缓存只放小元数据（任务状态、筛选 plan signature）
- 收到 Arrow Table → 转 JSON 或代理给前端后立即丢引用
- 长任务结果存 Python 侧（`KeyValueStore` 任务表），NestJS 只透传指针

## 7. 前端内存策略

- React Query 缓存按 page 切，不要把全部历史数据塞同一个 query key
- 表格 ≥ 100 行虚拟化（`@tanstack/react-virtual`）
- K 线图：lightweight-charts 自带按可视区域裁剪
- 大 Arrow 结果：分页拉，不一次取全量

## 8. 配置

```python
class MemorySettings(BaseSettings):
    polars_streaming: bool = True
    universe_slice_batch_size: int = 200
    max_concurrent_tasks: int = 2
    parquet_memory_map: bool = True
```

`max_concurrent_tasks` 控制并发任务数，避免叠加 OOM。

## 9. 监控

- 任务级：开始/结束时记录 RSS（`psutil.Process().memory_info().rss`），写 audit
- 全局：`/admin/health` 显示当前 RSS、近 1 小时峰值、活跃任务数
- 阈值：RSS > 4GB 时拒绝新任务，等当前完成

## 10. 测试

### 10.1 内存预算测试
- 跑单次筛选 + 形态匹配 → 断言峰值 RSS < 阈值
- 跑 2 个并发 → 断言不超 max_concurrent_tasks 限制

### 10.2 Arrow 传输测试
- 1MB / 10MB / 100MB Arrow 通过 Flight → NestJS → 解析后数据等同
- 性能基准：100MB < 800ms（不进 CI 默认）

### 10.3 内存泄漏测试
- 连续跑 50 次相同筛选 → 断言 RSS 不单调上升

## 11. 反模式（禁止）

```python
# ❌ 禁止：常驻全市场
class GlobalCache:
    def __init__(self):
        self.all = pd.read_parquet("data/kline/daily/*.parquet")  # 22GB

# ❌ 禁止：在循环里反复读同一文件
for code in codes:
    df = pd.read_parquet(f"data/kline/daily/{code}.parquet")
    process(df)
# 应改：iter_universe_slice 一次 SQL 取一批

# ❌ 禁止：把 Arrow 转成 list[dict] 再传
records = table.to_pylist()
return JSONResponse(records)   # 序列化爆炸 + 双倍内存
```

```ts
// ❌ 禁止：把整张表塞 Zustand
useStore.setState({ klineTable: rows })   // GC 不掉

// ❌ 禁止：fetch 后 JSON.parse 再立刻 stringify
const text = await res.text()
const obj = JSON.parse(text)
this.setState({ raw: text, parsed: obj })   // 内存翻倍
```

## 12. Open Questions

- v1 NestJS 收到 Arrow Flight 后转 JSON 给前端，还是直接转 binary？决策：v1 转 JSON（前端简单），v2 大结果集走 binary
- Polars streaming 在某些算子（rolling、group_by_dynamic）上还不完全支持——遇到时退回到分批 + 自己合并
- 是否引入 jemalloc 替换 glibc malloc 减少 Python 长跑碎片？v2 评估
