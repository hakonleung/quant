# Storage-Unify Rollout — Status

**Last updated:** 2026-05-15
**Owner:** storage-unify refactor

## What shipped

### Ports & adapters (`apps/api/src/common/storage/`)

| Port                          | Production adapter                                                             | In-memory fake                  |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| `RecordStore<V, K>`           | `DuckDBParquetRecordStore`                                                     | `InMemoryRecordStore`           |
| `TimeSeriesStore<Row>`        | `DuckDBParquetTimeSeriesStore` (flat `<prefix>.parquet`)                       | `InMemoryTimeSeriesStore`       |
| `KeyValueStore`               | (Redis adapter deferred)                                                       | `InMemoryKeyValueStore`         |
| `UserScopedRecordStore<V, K>` | `FileSystemUserScopedRecordStore` (per-user dir + LRU + legacy-JSON migration) | `InMemoryUserScopedRecordStore` |

Equivalence specs (`apps/api/test/common/storage/*.spec.ts`) keep prod
adapters and fakes in lock-step — 81 storage tests.

### Migrated stores

| Module                                   | Backing store                                           | Legacy source migrated automatically    |
| ---------------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| `BlacklistStore`                         | `RecordStore<BlacklistRow>`                             | `data/blacklist.json`                   |
| `SectorsStore`                           | `RecordStore<SectorRow>` (JSON-in-VARCHAR payload)      | `data/sectors/sectors.json`             |
| `TaCacheStore`                           | `RecordStore<TaCacheRow>` per code                      | `data/ta/{code}.json`                   |
| `SentimentCacheStore`                    | `RecordStore<...>` (stock + market shapes)              | `data/sentiment/**/*.json`              |
| `LedgerStore`                            | `UserScopedRecordStore<LedgerRow>`                      | `data/users/{uid}/_ledger/entries.json` |
| `WatchTaskStore`                         | `UserScopedRecordStore<WatchTaskRow>` (singleton blob)  | `data/users/{uid}/watch/tasks.json`     |
| `WatchGroupStore`                        | `UserScopedRecordStore<WatchGroupRow>` (singleton blob) | `data/users/{uid}/watch/groups.json`    |
| `UserLlmLedgerStore`                     | `UserScopedRecordStore<...>`                            | `data/users/{uid}/llm-ledger.json`      |
| `AgentHistoryStore`, `AgentPendingStore` | (intentionally in-memory only — v1 contract)            | —                                       |

All migrations are self-healing: on first access a per-user / per-store
adapter looks for the legacy JSON, imports it once, and renames it
`.bak` so future runs skip the conversion.

### Kline pipeline

- **Layout**: flat `data/kline/<prefix>.parquet` (13 files for A-shares,
  117 MB, 2.1 M rows). Per-partition file rewrite on each append; no
  LSM tier. Benchmark + decisions in `docs/perf/kline-write.md`.
- **Writer**: `KlineWriterService.appendBars` — used by the cron worker
  after every Python sync.
- **Reader**: `KlineReaderService` — backs `/api/kline/:code`,
  `/api/kline/bulk`, `TaService.fetchBars`, `CacheInspector.findStaleKline`,
  and `LocalKlineRefAdapter` (watch scheduler MA refs). **No Flight
  kline reads anywhere on the NestJS side.**
- **Cron worker**: `KlineWorker.process` consumes the Arrow bars table
  returned by Python's `sync_kline_for_code` and pushes it through
  `KlineWriterService`. Mode / counts / `new_last_date` ride in schema
  metadata.
- **One-shot importer**: `apps/api/scripts/import-kline-legacy.ts`
  rewrites `data/kline/<code>.parquet` → `data/kline/<prefix>.parquet`
  with per-code row-count verification.

### Retired Python Flight ops

After NestJS's kline reads went fully local, three read-side ops were
deleted from `quant_rpc/ops/`:

- `list_kline_for_code` — was the per-code last-N reader.
- `list_kline_bulk_last_n` — was the bulk-codes last-N reader.
- `list_kline_watermarks` — was the universe-watermark scan used by
  `CacheInspector.findStaleKline`; replaced by
  `KlineReaderService.lastTradeDates` over the local parquet.

The Python service now exposes exactly one kline op:
`sync_kline_for_code` — the bars-pushing one.

### CLAUDE.md updates

- §9.3 added: "Parquet 不要按业务主键分到 ≥ 1000 文件"
- §9.3 added: "每天跑一次的 batch 任务不要为'写延迟'加 LSM/delta"

## What didn't ship (and why)

### Python persistence teardown (read side) — DONE

Shipped 2026-05-15 (commit `refactor(kline): retire data/kline.py/ —
Python reads NestJS-canonical store`). One canonical kline store at
`data/kline/<prefix>.parquet`. Approach:

- New `FlatPrefixKlineRepo` reads the float64 layout via DuckDB and
  casts back to `decimal128` at the boundary so screen / pattern /
  blacklist keep getting exact Decimal precision.
- `pct_chg_qfq` synthesised via a `LAG()` window so the screen DSL
  still has a per-bar return field; raw OHLC / `adj_factor` dropped
  from the on-disk layout.
- `_maybe_recompute_only` removed — the factor-change short-circuit
  needed `adj_factor`. The orchestrator catches recomputes via the
  watermark on the next business day; ex-div code pays at most one
  extra akshare fetch per event.
- `KlineService.sync_code` returns `(report, bars)` but no longer
  writes (NestJS's `KlineWriterService` is the sole writer).
- Tests: new `tests/_util/kline_seeder.py` seeds canonical-layout
  parquets from DailyBar lists; 5 integration tests rewired.

The legacy `data/kline.py/` directory is now safe to delete — none of
the Python services reference it.

### `StockSnapshotDto` range pct_chg projector (item 9) — DONE

Shipped 2026-05-15 in commit `feat(meta): persist returns + derived
metrics on stock_meta after each kline sync`. Design:

- **Storage**: 15 nullable columns added to `data/meta/stocks.parquet`
  (`metrics_asof`, `metrics_updated_at`, six `ret_*`, seven derived).
- **Compute**: Python `compute_metrics(meta, bars)` — wraps existing
  `derive_metrics` with the new return-window math. No TS port needed.
- **Trigger**: NestJS `KlineWorker.process` calls
  `upsert_stock_metrics_for_code` per code as a best-effort post-hook
  after `KlineWriterService.appendBars`.
- **Failure mode**: a projector error is logged at WARN; the kline sync
  succeeds. The snapshot handler's on-demand fallback still works when
  the persisted block is missing or stale.

**Open follow-up**: none — the batched
`upsert_stock_metrics_for_codes` op shipped 2026-05-15 and rewrites
`stocks.parquet` once per batch instead of N times.

### Snapshot handler reads persisted block — DONE

Shipped 2026-05-15 in commit `feat(snapshot): serve list_stock_snapshots
from persisted meta.metrics`. `ListStockSnapshotsHandler` prefers
`meta.metrics` when populated (zero kline reads), falls back to the v1
on-demand recompute via `KlineService.get_last_n` for legacy / never-
projected codes. `price` was added to `PersistedMetrics` so the row can
be served without any kline read at all.

### Redis L1 cache (item 5)

Never built. The plan called for a `RedisKeyValueStore` adapter +
`CachedRecordStore` wrapper to put hot reads (universe latest, watch
quotes, meta) behind Redis. Reasonable to defer until we see real
read-pressure that the in-process / parquet path can't absorb — the
storage layer's port surface already supports plugging it in.

### Generic `data/` verify script — DONE

Shipped 2026-05-15 as `apps/api/scripts/verify-data.ts`. Walks every
parquet under `data/`, confirms readability + required columns,
verifies kline-code → meta-row cross-store consistency, enumerates
per-user stores, and flags rollback anchors / un-migrated JSON. Exits
non-zero only on real errors (missing required columns, unreadable
parquet, cross-store orphans). Run:

```
pnpm --filter @quant/api tsx scripts/verify-data.ts
```

Sample output on current dev data: `ok=10 warnings=70 errors=0`
(warnings are intentional — sentiment cache is lazy-migrated and
`.bak` files are deliberate rollback anchors).

### Migration verify script for the whole `data/` dir (item 11)

`import-kline-legacy.ts` has per-code row-count verification baked in
for the one-shot kline import; `verify-data.ts` covers the rest.
A generic "compare legacy JSON to new parquet" verify across every
migrated store does not exist; each `*.bak` file is the rollback
anchor and per-store tests cover the migration path.

## Verifying current state

```sh
# 1. NestJS suite (storage + module migrations + controller flip)
pnpm --filter @quant/api jest             # 65 suites / 530 tests
pnpm --filter @quant/api tsc --noEmit     # clean

# 2. Python suite (sync_code tuple return + kline_root isolation)
./.venv/bin/python -m pytest services/py -q   # 481 tests

# 3. Real-data smoke (controller path)
node -e "
const { DuckDBInstance } = require('@duckdb/node-api');
(async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  const r = await c.runAndReadAll(\\\"SELECT count(DISTINCT code)::INTEGER AS codes FROM read_parquet('data/kline/*.parquet');\\\");
  console.log(r.getRowObjects());  // ~5500
})();
"

# 4. End-to-end kline read against the new flat layout
# (HTTP smoke would go here once the api process is running)
```

## Suggested next moves, in priority order

1. **Snapshot handler reads persisted metrics** — flip
   `ListStockSnapshotsHandler` to prefer the now-populated meta block
   over the 5-min on-demand recompute (~30 min, Python-only). Then
   delete the `FULL_CACHE_TTL_SEC` layer.
2. **Python read-side flip** — pick A or B above; A is cleaner long
   term. Once done, delete `quant_cache/parquet_kline_repo.py` and the
   `overwrite_bars` call in `KlineService.sync_code`.
3. **Redis L1** — only if profiling shows the watch-tick `loadMaRef`
   path is too slow at scale. The flat parquet read benches at
   < 10 ms per code; probably not bottleneck yet.
4. **Generic verify script** — nice to have for production cutover;
   currently each per-store self-migration writes a `.bak` rollback
   anchor.
