# Kline LSM Write Path — Baseline Bench

**Date:** 2026-05-12
**Author:** storage-unify refactor
**Status:** baseline (pre-prod)

## 背景

旧布局是 `data/kline/<code>.parquet` 一支股票一个文件，A 股 ≈ 5500
parquet。问题：

1. 文件句柄数高、`duckdb.read_parquet([5500 paths])` 列表序列化 + 句柄
   开销显著。
2. 单 code 日更若按 "rewrite per-code parquet" 走，单日全市场重写 27GB+。
3. universe slice / screening 必须遍历 5500 文件。

新方案 (CLAUDE.md §9 + plan §3)：

- 按 `code[:3]` 分到 ~27 个分区目录
- 每分区 LSM 布局：`00000000000000-main.parquet` + N 个 `*-delta.parquet`
- 写：只追加 delta（per-partition mutex 仅锁 rename）
- 读：glob + `QUALIFY row_number() OVER (PARTITION BY code, ts ORDER BY
  filename DESC) = 1` 做去重
- compact：定时 cron 合并 main + deltas → 新 main，删除观察到的旧 deltas

## 方案权衡

为什么不直接整分区 rewrite？

- 一分区 ≈ 1M 行 / ~70MB；按 code 日更触发的写放大不可接受
- LSM 让"实时写"≪"周期 compaction"

为什么不分到更细粒度（如 code 全位）？

- 5500 文件回到老问题
- 27 分区即足以让 daily write 在 1 秒内完成（实测）

为什么不直接走 PARTITION_BY hive？

- DuckDB hive 写需要全表重写；LSM 路径仅写 delta，避免每日重写主文件
- compaction 时仍可借 DuckDB COPY 完成合并，组合最佳

## 量化结果（M1, NVMe, 27.5M rows / 1.9 GB on disk）

| Op | Latency | Note |
| --- | --- | --- |
| 冷回填全量 (27.5M rows) | **5.5 s** | DuckDB COPY 内部生成；migration 一次性 |
| 日更 5500 rows / 27 partitions | **102 ms** | +80 KB disk growth |
| 10 batch trickle (5500 rows total) | 164 ms | 16 ms/batch；产生 270 个 delta |
| 单 code 30-bar tail（延迟读） | 10 ms | post-compact: 5 ms |
| 100-code latest | 131 ms | LayeredStore 命中 Redis 时应 < 5 ms |
| **universe lastTimestamps (5500 codes)** | **640 ms** | 全市场扫描；Redis 必须缓存这个查询 |
| 全分区 compact (27 partitions) | 2.7 s | 离线 cron 跑；不占在线延迟 |

写放大：每日仅 +80 KB（新数据本身）。 plan 中担心的 2.2 GB/天属于
朴素 rewrite 方案，LSM 路径下根本不存在。

## 回归风险与监控点

- **delta 文件数失控**：如果 compaction cron 长时间没跑（如机器掉电），
  delta 数堆到上千会拖慢读。监控指标：`kline_partition_file_count` per
  prefix；阈值 ≥ 50 触发告警。
- **universe latest 退化**：640 ms 太长不能进 watch tick 热路径。
  必须套 LayeredStore + Redis；Redis 失效时降级回该路径，watch tick
  会卡 ~1s — 可接受作 fallback，但要告警 `redis_cache_miss_ratio > 0.5`。
- **compaction 期间写阻塞**：单分区 compact 持 mutex ~100ms；批量
  trickle 写在此期间排队。验证：100 ms 队头延迟可接受；如果以后单分区
  >1M 行（不太可能），考虑切到"双 main 文件 + 原子翻转"。

## 复现命令

```
pnpm --filter @quant/api tsx scripts/bench-kline-write.ts
```

## 回写 CLAUDE.md 的经验

→ §9.3 性能优先 增补一条："小文件 N+1 反例：parquet 不要按业务主键
分到 ≥ 1000 文件；先估算 read 时的 glob/list 开销，超过 5500 文件几乎
必然踩 OS dirent + DuckDB scheduler 限制。" 已经在 §9.3 列入"主路径
禁项 = 列表 / 表格 UI 不走虚拟化"附近，下次落 CLAUDE.md 时一并加。
