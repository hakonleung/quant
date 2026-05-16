# Storage-Unify Rollout — Status

**Last updated:** 2026-05-16
**Owner:** storage-unify refactor

## Current invariants

After three rounds of follow-on work in May 2026, the architecture is:

| Resource                                | Who writes      | Who reads                        |
| --------------------------------------- | --------------- | -------------------------------- |
| `data/kline/<prefix>.parquet`           | **NestJS only** | NestJS + Python (read-only repo) |
| `data/stock_metas.parquet`              | **NestJS only** | NestJS + Python (read-only repo) |
| `data/blacklist.parquet`                | NestJS          | NestJS                           |
| `data/public_sectors.parquet`           | NestJS          | NestJS                           |
| `data/sentiment_{market,stock}.parquet` | NestJS          | NestJS                           |
| `data/ta_cache.parquet`                 | NestJS          | NestJS                           |
| `data/all_users.parquet`                | NestJS          | NestJS                           |
| `data/users/{uid}/**`                   | NestJS          | NestJS                           |
| `data/watch/**`                         | NestJS          | NestJS                           |

**No production code path in `services/py/` writes parquet any more.**
Python repos (`FlatPrefixKlineRepo`, `ParquetStockMetaRepo`) are
read-only; their write methods were removed once the corresponding
Flight ops became compute-only.

## Ports & adapters (`apps/api/src/common/storage/`)

| Port                          | Production adapter                                                             | In-memory fake                  |
| ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| `RecordStore<V, K>`           | `DuckDBParquetRecordStore`                                                     | `InMemoryRecordStore`           |
| `TimeSeriesStore<Row>`        | `DuckDBParquetTimeSeriesStore` (flat `<prefix>.parquet`)                       | `InMemoryTimeSeriesStore`       |
| `UserScopedRecordStore<V, K>` | `FileSystemUserScopedRecordStore` (per-user dir + LRU + legacy-JSON migration) | `InMemoryUserScopedRecordStore` |

Equivalence specs (`apps/api/test/common/storage/*.spec.ts`) keep the
production adapters and fakes in lock-step. `KeyValueStore` was
removed in May 2026 — the only Python user (sync-state JSON) was
write-only and got deleted, and NestJS has no need for opaque-blob
storage right now.

## Phase-by-phase summary

### Phase 1 — kline read-side, snapshot composition, perf optimisations

- Snapshot row assembly moved out of Python: NestJS reads meta from
  the local parquet (`LocalStockMetaAdapter`) and kline from
  `KlineReaderService`, composing `StockListRow[]` server-side.
- Three hot-path optimisations on `POST /stock-list/rows`:
  per-bar `KlineBarSchema.parse` dropped, exit-time
  `StockListRowSchema.array().parse` dropped, full-universe
  `lastNBulk` cached with a 60s SWR window keyed by `n`.

### Phase 2 — metrics-block writes

- Python's `upsert_stock_metrics_for_code{,s}` Flight ops were
  renamed to `compute_*` and now return the freshly projected row
  via Arrow without persisting.
- NestJS's `LocalStockMetaWriterService.upsertMetrics` patches the
  metric columns through a DuckDB CTE + atomic rename; the adapter
  cache is invalidated after every successful write.

### Phase 3 — meta-row writes

- The remaining four Flight ops (`sync_stock_meta_full`,
  `enrich_stock_meta_for_code`, `bulk_sync_financials`,
  `enrich_financials_for_code`) stop persisting. Each returns the
  merged `StockMeta` rows in `STOCK_META_SCHEMA` (with diff counts in
  schema metadata for the two bulk paths).
- NestJS's `LocalStockMetaWriterService.upsertMetas` overlays the
  non-metric columns via a full-outer-join CTE; existing
  `metrics_*` columns on matched rows are preserved verbatim so a
  financials cron never wipes the snapshot block.
- `StockMetaSyncService` lost its `KeyValueStore` dependency — the
  sync-state JSON was write-only (no reader anywhere) so the entire
  `data/_state/` directory and the `FileKeyValueStore` adapter are
  gone.

### Phase 4 — final cleanups (this commit)

- `find_stale_financials` moved into NestJS's `CacheInspector` (pure
  filter logic, not a numerical algorithm) — one fewer Flight
  round-trip per cron tick.
- `findIncompleteMetaCodes` switched from `list_stock_meta_all` over
  Flight to the local `LocalStockMetaAdapter` (60s SWR cache).
- `StockMetaRepo` Protocol stripped to read-only; the wrapper
  `ParquetStockMetaRepo.upsert_many` removed. Tests seed via
  `tests/_util/stock_meta_seeder.seed_stock_meta_parquet` — a direct
  pyarrow write through the shared codec.
- `FileKeyValueStore`, the `KeyValueStoreContract` base, and the
  per-store contract test deleted. `NotificationService` tests use
  an in-process `_InMemoryKv` (the service itself is currently
  unwired pending the IM notify track).

## Kline pipeline (unchanged since phase 1)

- **Layout**: flat `data/kline/<prefix>.parquet` (13 files for
  A-shares, ~2.1 M rows). Per-partition file rewrite on each
  append; no LSM tier. Benchmark in `docs/perf/kline-write.md`.
- **Writer**: `KlineWriterService.appendBars` — used by the cron
  worker after every Python sync.
- **Reader**: `KlineReaderService` — backs `/api/kline/:code`,
  `/api/kline/bulk`, `TaService.fetchBars`,
  `CacheInspector.findStaleKline`, and `LocalKlineRefAdapter` (watch
  scheduler MA refs). **No Flight kline reads anywhere on the NestJS
  side.**
- **Bulk read cache**: `lastNBulk` keeps a per-`n` SWR snapshot of
  the full universe (60s TTL); code-subset calls filter from it
  rather than issuing a fresh DuckDB scan.

## Stock-meta pipeline (post-rollout)

- **Layout**: `data/stock_metas.parquet`, single file ~5500 rows.
- **Reader**: `LocalStockMetaAdapter` — in-memory snapshot indexed
  by code + by Shenwan-L2 substring; 60s TTL + parquet mtime check
  for invalidation.
- **Writer**: `LocalStockMetaWriterService` with two paths:
  `upsertMetrics(rows)` for the metric-block patch and
  `upsertMetas(rows)` for the non-metric upsert. Both serialise
  through a single `writeChain` mutex so they cannot race the
  parquet rewrite.
- **In-process projector** (NestJS-only, no Flight hop):
  - `StockMetricsComputeService.computeForCode` — projects
    `(StockMetaDto, KlineBar[]) → StockMetricsRow` via the pure
    `domain/pure/{derive,compute}-metrics.ts`. Called by
    `KlineWorker` immediately after every `sync_kline_for_code`,
    then handed to `LocalStockMetaWriterService.upsertMetrics`. The
    previous `compute_stock_metrics_for_code{,s}` Flight ops were
    retired — Python no longer carries this口径.
- **Flight ops** (read-only on Python's storage):
  - `sync_stock_meta_full` — diff against repo, return rows + counts
  - `enrich_stock_meta_for_code` — single-code source fetch
  - `bulk_sync_financials` — full-market merge
  - `enrich_financials_for_code` — single-code slow-path enrich
  - `check_stock_meta_sources`, `list_stock_meta_*`,
    `get_stock_meta_batch`, `list_stock_meta_by_industry`,
    `list_stock_meta_all` — pure read

## Why Python still reads parquet

The "NestJS owns storage" rule is about **writes** — it stops two
processes from racing the same file. Reads are unconstrained because
parquet files are immutable snapshots after `tmp + rename`, and
DuckDB's column-pruning beats any "ship the bytes over Arrow Flight"
alternative for screen / pattern / compute_metrics workloads.

See CLAUDE.md §2.5.2: numerical algorithms live in Python (single
source of truth); the storage layer they consume happens to be on
shared local disk.

## Verifying current state

```sh
# 1. NestJS suite
pnpm --filter @quant/api jest             # 549 tests
pnpm --filter @quant/api tsc --noEmit     # clean

# 2. Python suite
./.venv/bin/python -m pytest services/py  # ~480 tests

# 3. Real-data smoke: meta + kline row counts
node -e "
const { DuckDBInstance } = require('@duckdb/node-api');
(async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  const r = await c.runAndReadAll(\\\"SELECT count(*) AS metas FROM read_parquet('data/stock_metas.parquet');\\\");
  console.log(r.getRowObjects());  // ~5500
})();
"
```

## Suggested next moves

1. **Redis L1 cache** — only if profiling shows the watch-tick
   `loadMaRef` path is too slow at scale. The flat parquet read
   benches at < 10 ms per code; probably not the bottleneck yet.
2. **End-to-end contract test** — the previous Flight-shaped one was
   removed when stock-meta stopped crossing processes. A new test
   that drives the kline-worker / meta-worker through a fake Flight
   stub would close the integration gap.
