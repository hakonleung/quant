# Kline Flat-Partition Write Path — Baseline Bench

**Date:** 2026-05-14
**Author:** storage-unify refactor
**Status:** prod baseline

## 背景

旧布局是 `data/kline/<code>.parquet` 一支股票一个文件，A 股 ≈ 5500
parquet。问题：

1. 文件句柄数高、`duckdb.read_parquet([5500 paths])` 列表序列化 + 句柄
   开销显著。
2. universe slice / screening 必须遍历 5500 文件。
3. 模式 = `Decimal(20,4)`，列存压缩潜力没吃透。

新方案：

- **Flat 分区**：按 `code[:3]` 切到 `data/kline/<prefix>.parquet`，A 股 ≈ 13 个文件
- **写**：`appendBars` = read existing + merge by (code, ts) + write tmp + atomic rename，per-partition mutex 串行化
- **读**：`read_parquet(['000.parquet', '300.parquet', ...])` 命中所需 prefix 文件即可
- **schema**：`DOUBLE` (前复权价 / amount / turnover / ma) + `BIGINT volume` + `DATE ts`
- **没有 LSM**：实测一次 partition rewrite ≈ 50 ms，13 个 partition 全量重写 < 1s，
  delta + compaction 这层增加的运维负担不划算。

## 方案权衡

为什么放弃 LSM（main + delta）？

- 实测：用真实 dev 数据 (5508 codes, 2.1M rows, 117MB) 跑过 main-only-rewrite，
  整 partition rewrite ≈ 50 ms，13 个 partition 全量 700 ms。
- 日更负载只有 ~5500 行 / 13 partition ≈ 420 行/partition/天，
  cron 1s 内完成。
- LSM 的复杂性收益主要是把"写延迟"从全文件 rewrite 降到 append；
  对一个每天跑一次的 batch 任务，这个收益不存在。
- delta + compaction 引入：partition 文件夹布局、compaction cron、
  delta clock、deltas 失控时的告警 …… 全部省掉。

为什么不分到更细粒度（如 code 全位）？

- 5500 文件 = 老问题：DuckDB `read_parquet([list])` 调度开销显著。

为什么不分到更粗粒度（单文件全市场）？

- 单文件 ~120MB；append 时 rewrite 整文件 ≈ 600 ms（实测）。13 partition
  各跑 ~50 ms 并行后 < 200 ms wallclock，cache-friendly 也更好。

## 量化结果（M1, NVMe）

数据集：dev 真实 A 股 kline，2.1M rows / 117 MB on disk。

| Op                                             | Latency            | Note                       |
| ---------------------------------------------- | ------------------ | -------------------------- |
| 一次性导入（5508 文件 → 13 flat parquets）     | **1.0 s**          | 历史数据落库               |
| 单 partition rewrite (existing + few new rows) | **~50 ms**         | per file                   |
| 整 partition 全量 rewrite (13 files 并行)      | < 200 ms wallclock | 日更预估上限               |
| 单 code 30-bar tail                            | 5-10 ms            | direct partition 命中      |
| 100-code latest (跨多个 partition)             | ~100 ms            | 主要是 partition file open |

后续可优化点（先记着，做完 v2 watch 再回来）：

- 把热门 partition（如 `000`, `002`, `300`, `600`, `603`, `688`）mmap 进 Redis 做 L1
- `read({entityKeys})` 直接按 prefix 过滤 SQL，避免 partition-level scan

## 回归风险与监控点

- **partition rewrite 失败留下 `.tmp-*` 文件**：当前 `rm` 在 catch 里清理，
  但 SIGKILL 时会残留。监控：`data/kline/*.tmp-*` 不应存在；启动期扫一次清掉。
- **(code, ts) 冲突处理**：当前实现是"new 覆盖 old"，这是 adjustment-factor
  回填想要的语义；但如果上游误传同一 (code, ts) 不同值会被静默接受。
  补救：watch 层校验 adjustment_factor 变化时打日志。

## 复现命令

一次性导入 / 验证：

```
pnpm --filter @quant/api tsx scripts/import-kline-legacy.ts
# (校验 PASS 后)
mv data/kline data/kline.bak && mv data/kline.new data/kline
```

读冒烟：

```
node -e "
const { DuckDBInstance } = require('@duckdb/node-api');
(async () => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const r = await conn.runAndReadAll(\"SELECT count(DISTINCT code)::INTEGER AS codes, count(*)::INTEGER AS rows FROM read_parquet('data/kline/*.parquet');\");
  console.log(r.getRowObjects());
})();
"
```

## 回写 CLAUDE.md 的经验

→ §9.3 已经收录："Parquet 不要按业务主键分到 ≥ 1000 文件"。
还要补一句："对一天跑一次的 batch 任务，不要为'写延迟'优化掉简单性 —
50 ms 整文件 rewrite vs. delta+compaction 的复杂性收益不存在。"
下次落 CLAUDE.md 时一并加。
