# RFC 0002 — 增量更新与错误恢复

| Status | Draft      |
| ------ | ---------- |
| Date   | 2026-05-01 |

## 1. 背景

数据更新是项目最容易"看似简单实则致命"的部分。常见失败模式：

- 网络抖动 → 部分股票拉取失败
- 数据源 schema 变化 → pydantic 校验大面积失败
- 程序崩溃 → 写到一半的状态
- 除权除息日 → adj_factor 变化但未触发回算
- 静默漂移 → 多个数据源对同一股票同一天给不同值

本 RFC 给出统一的**水位 + 死信 + 对账**方案。

## 2. 核心原则

1. **写数据先于写水位**：任何顺序倒置都会导致漏数据
2. **水位 + 数据原子化**：同一张表/文件内一次性提交，或用 staging file + rename
3. **每个 entity 独立任务**：单只股票失败不影响其它
4. **失败不丢，进死信**：所有失败带足够上下文重跑
5. **对账可回溯**：定期 reconciler 对照源/缓存，差异写审计

## 3. 任务分层

```
                 ┌──────────────────────────┐
                 │  ScheduledJob (cron)     │     // 例: kline.daily.fetch @ 18:00
                 └──────────────┬───────────┘
                                ▼
               ┌──────────────────────────────┐
               │  fan-out: 5500 EntityTask    │
               └─────────────┬────────────────┘
                             ▼
        ┌─────────────────────────────────────────┐
        │  EntityTask  (一只股票的一次增量)        │
        │   1. 读 watermark                        │
        │   2. fetch 增量                          │
        │   3. validate (pydantic)                 │
        │   4. 检查 adj_factor 是否变 → 触发回算  │
        │   5. compute_qfq + compute_ma            │
        │   6. write parquet (.tmp + rename)       │
        │   7. 更新 watermark                      │
        │   8. 写 audit                            │
        └─────────────────────────────────────────┘
```

## 4. 状态机

```
EntityTask 状态：

  PENDING ──► RUNNING ──► SUCCEEDED
                │
                ├──► FAILED_TRANSIENT ──► RETRY (max 3) ──► (PENDING)
                │
                ├──► FAILED_PERMANENT ──► DEAD_LETTER ──► (人工修)
                │
                └──► FAILED_LOOKAHEAD ──► SKIPPED （拉到了未来日，丢弃）
```

转移规则：

- `TimeoutError` / `RateLimited` / `5xx` → `FAILED_TRANSIENT`
- `pydantic.ValidationError` / `4xx`（业务错误） → `FAILED_PERMANENT`
- 拉到 `trade_date > today` → `FAILED_LOOKAHEAD`（不入死信，记 audit）

## 5. 死信存储

```
data/_dead_letter/<job_name>.parquet
```

schema：

```
job          STRING
entity_key   STRING        -- "600519"
payload      STRING (JSON) -- 重跑参数：start, end, source, ...
error_code   STRING
error_message STRING
attempt_count INT
first_failed_at TIMESTAMP
last_failed_at  TIMESTAMP
trace_id     STRING
```

### 5.1 重跑流程

- 启动时 + 每次调度时扫死信
- `attempt_count < max_retries` → 重排到下次调度，attempt_count++
- `attempt_count >= max_retries` → 标 `WAITING_HUMAN`，发告警
- 人工修复后 CLI / UI 触发"重跑"，成功后 delete row

### 5.2 死信查看

- UI `/admin/dead-letter` 列表 + 详情 + 一键重跑
- CLI：`python -m quant_io.dlq list/retry/clear`

## 6. 水位粒度

### 6.1 KLine（按 entity）

```json
{
  "kline.daily": {
    "by_code": {
      "600519": {
        "last_date": "2026-04-30",
        "last_adj_factor": "1.0000",
        "schema_version": 3,
        "updated_at": "2026-05-01T10:00:00Z"
      }
    }
  }
}
```

### 6.2 News（全局，按时间）

```json
{
  "news.akshare": { "last_published_at": "2026-05-01T03:00:00Z" }
}
```

为什么差异？KLine 按股票切分文件；新闻按月切分，单条新闻无法独立"重跑"，按时间游标更自然。

## 7. 对账（Reconciliation）

### 7.1 何时对账

- 主源恢复后第一次成功跑完时
- 切换主源时
- 用户主动触发"全量校验"

### 7.2 对账方式

- 抽样：随机选 100 只股票 × 最近 30 天
- 调主源 + 兜底源各取一遍 → 对比 OHLCV + adj_factor
- 差异写：

```
data/_audit/discrepancy.jsonl
{ "code": "...", "date": "...", "field": "close", "main_source_value": ..., "fallback_value": ..., "delta_pct": ..., "trace_id": "..." }
```

- 阈值告警：单股票超过 5 个字段差异 > 0.1% → 醒目告警

### 7.3 自动修复

- 默认**不**自动改数据；人工 review 后决定
- 仅记录，避免覆盖错的把"对的也覆盖了"

## 8. Schema 演进

### 8.1 数据 schema_version

- 每个 parquet 文件元数据里记 `schema_version: int`
- 读取时若版本低于代码 → 走自动迁移函数（`quant_cache/migrations/<from>_to_<to>.py`）
- 写入时一律新版本

### 8.2 来源 schema 漂移

- 来源新增字段 → adapter 默认忽略；没影响
- 来源删除/重命名字段 → pydantic 校验失败 → 整批进死信 → 告警 → 人工更新 adapter

### 8.3 双写期（v2 切后端时）

- 切后端步骤：先双写一周，期间每日跑对账（新旧后端读相同数据应一致），全量通过后切读路径，再隔一周下线旧

## 9. 锁与并发

- 同一 entity 的多个写入互斥：`filelock`，文件名 `data/kline/daily/.lock-600519`
- 不同 entity 完全并发；并发上限 = `min(8, source_rate_limit / 调用频率)`
- 读路径不加锁（读 parquet 是原子的，rename 也是原子的）

## 10. 一致性保证

| 项                                | 保证                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| 数据存在但水位未更新              | 下次重跑会再次写相同数据（幂等）                            |
| 水位更新但数据未存                | 不可能（顺序保证）                                          |
| 进程崩溃在写文件中途              | `.tmp` 留下，无损坏；下次启动检测并清理                     |
| 进程崩溃在 rename 后 watermark 前 | 数据已存，下次重跑增量起点重叠几行（upsert 覆盖，无副作用） |

## 11. 性能预算（增量）

| 任务                             | 预算             |
| -------------------------------- | ---------------- |
| 单只股票增量（1 天，2 表）       | < 100ms 含网络   |
| 全市场 kline 增量（5500 只）     | < 5min（并发 8） |
| 全市场 news 增量                 | < 60s            |
| Reconciliation（100 只 × 30 天） | < 3min           |

## 12. 监控与告警

### v1（轻量）

- 每次 ScheduledJob 末写 `data/_audit/<date>.jsonl` 一行 summary
- 死信表 row count > 50 时，下次启动在 stderr 醒目打印
- UI 顶部有"数据健康"指示灯（绿/黄/红）

### v2（生产）

- Prometheus metrics（详见 `data-sources.md` §12）
- Webhook 告警（飞书 / 邮件）

## 13. 测试

- **故障注入**：fake source 在第 N 次调用抛错，断言进死信 + 状态正确
- **崩溃恢复**：模拟在 rename 前 kill -9（用 monkey-patch），断言下次启动数据一致
- **schema 漂移**：fake source 返回缺字段，断言进死信 + 不污染水位
- **adj_factor 变化**：模拟某天 adj_factor 变 → 断言触发该股票全量回算

## 14. Open Questions

- 死信"WAITING_HUMAN"超过 24 小时自动升级告警级别？
- 用户主动"全量回填某只股票"是普通任务还是特权操作？建议进 admin 页，单股票任意时间窗口
