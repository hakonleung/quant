# 2026 storage unify — migration runbook

## Scope

Replaces every per-module JSON / Parquet store under `data/` with the
unified `RecordStore` / `UserScopedRecordStore` ports (commits
`a073d23` → `80942b1`). Stores covered:

- **Shared**: `BlacklistStore`, `SectorsStore`, `TaCacheStore`,
  `SentimentCacheStore` (stock + market).
- **User-scoped**: `LedgerStore`, `WatchTaskStore`, `WatchGroupStore`,
  `UserLlmLedgerStore`.
- **In-memory only (no migration needed)**: `AgentHistoryStore`,
  `AgentPendingStore`.

Kline + StockMeta are **not** yet on this track — handled by the kline
cross-process flip and the meta wide-table projector.

## Self-healing

Each migrated store performs its own one-shot legacy adoption on first
access:

1. On `load()` / first `get`, the store checks the new parquet.
2. If empty, it looks for the legacy JSON file at its known path
   (e.g., `data/blacklist.json`, `data/users/{uid}/_ledger/entries.json`).
3. If present, the legacy JSON is parsed, validated, written into the
   parquet, and renamed to `.bak`.
4. On subsequent accesses the parquet is the source of truth; `.bak`
   files are kept for ≥ 7 days as a rollback anchor (per plan §6.4).

There is **no separate "run me before you deploy" migration step**.

## Verification

`apps/api/scripts/verify-storage-migration.ts` is the non-destructive
audit:

```
pnpm --filter @quant/api tsx scripts/verify-storage-migration.ts \
  --data-root /path/to/data \
  --report-out /tmp/migration-report.md
```

For every legacy `.bak` file in `--data-root`, the script reads the
matching parquet, projects it back to the legacy JSON shape, and
deep-compares. Exit code:

- `0` — every check passed
- `1` — one or more mismatches; details in the report
- `2` — fatal error before comparison (bad data-root, etc.)

Suggested cadence:

- **Right after first deploy**: run once to confirm every `.bak`
  matches.
- **Day +7**: re-run; if still PASS, `.bak` files can be archived /
  removed.

The script's own behaviour is guarded by
`apps/api/test/scripts/verify-storage-migration.spec.ts` (PASS / FAIL /
zero-bak cases).

## Rollback

Each store keeps `.bak` next to where it found the legacy file. To
revert a single store:

1. Stop the NestJS process.
2. `mv data/<store>.parquet data/<store>.parquet.replaced`.
3. `mv data/<store>.json.bak data/<store>.json` (path varies per
   store — see the module's `legacyJsonPath` factory).
4. Roll the API binary back to the commit immediately before that
   store's migration (`git log --oneline | grep migrate`).
5. Restart.

User-scoped stores additionally need the per-user `.bak` reversion
under `data/users/{uid}/...`.

## Kline layout migration (separate from JSON退役)

The legacy kline layout (`data/kline/{code}.parquet`, ~5500 files,
`Decimal(20,4)` columns) needs an explicit conversion to the new LSM
shape (`data/kline/{prefix}/00000000000000-main.parquet`, ≤ 40 files,
`DOUBLE`). The conversion is **not** self-healing — the layouts share
a parent path, so the script stages into `data/kline.new/` and the
caller swaps directories.

Run:

```
pnpm --filter @quant/api tsx scripts/import-kline-legacy.ts \
  [--data-root /path/to/data] [--limit N]
```

- Stages every legacy `{code}.parquet` into the prefix-keyed LSM
  layout under `data/kline.new/`.
- Casts `Decimal(20,4)` → `DOUBLE` in-engine (no row-by-row JS).
- Drops legacy-only columns (`open/high/low/close` non-qfq,
  `pct_chg_qfq`, `adj_factor`); keeps only the columns the new
  `KlineRow` shape uses.
- Built-in verify step: counts rows per code on both sides; non-zero
  exit code on any mismatch.

Reference performance on dev hardware (M1, NVMe, 5508 files → 13
partitions, 2.1M rows):

| Step                        | Time     |
| --------------------------- | -------- |
| 13-partition import + write | ~1.0 s   |
| Per-code row count verify   | < 1 s    |

After a successful run, the operator manually swaps:

```
mv data/kline data/kline.bak
mv data/kline.new data/kline
```

Rollback is the inverse `mv`.

## Production status (2026-05-13)

| Store              | Migration commit | Verified by script |
| ------------------ | ---------------- | ------------------ |
| Blacklist          | a073d23          | ✓                  |
| Sectors            | cf65d13          | ✓                  |
| TaCache            | cf65d13          | (no live data yet) |
| SentimentCache     | cf65d13          | (no live data yet) |
| Ledger             | 15941aa          | (no live data yet) |
| WatchTask[admin]   | 80942b1          | ✓                  |
| WatchGroup[admin]  | 80942b1          | ✓                  |
| UserLlmLedger      | 80942b1          | (no live data yet) |
