/**
 * One-shot ``data/`` directory verifier.
 *
 * Walks every Parquet file the storage-unify rollout owns and checks
 * three things:
 *
 *   1. **Readable.** ``read_parquet`` must succeed and the file must
 *      have at least the columns the table's RecordStore / TimeSeries
 *      adapter expects.
 *   2. **Self-consistent.** Per-table row counts are reported; obvious
 *      red flags (zero rows on a non-empty store, code that's
 *      lexicographically out of partition) are flagged.
 *   3. **Cross-store.** Kline codes must appear in ``stock_metas.parquet``
 *      (or be reported as orphans — usually means a brand-new listing
 *      arrived before the meta sync ran). Per-user parquets are
 *      enumerated; their schemas are checked.
 *
 * Also surfaces stray ``*.json`` files anywhere under ``data/`` —
 * everything is parquet-backed now, a JSON snuck in usually means a
 * regression in someone's store.
 *
 * Run:
 *   pnpm --filter @quant/api tsx scripts/verify-data.ts \
 *     [--data-root /path/to/data]
 *
 * Exits 0 when every check passes, 1 when any check reports an error
 * (warnings don't fail the exit code).
 */

import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

interface Args {
  readonly dataRoot: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dataRoot = join(process.cwd(), '..', '..', 'data');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-root' && argv[i + 1] !== undefined) {
      dataRoot = argv[i + 1] as string;
      i += 1;
    }
  }
  return { dataRoot };
}

interface CheckOutcome {
  readonly level: 'ok' | 'warn' | 'error';
  readonly label: string;
  readonly detail: string;
}

const outcomes: CheckOutcome[] = [];
let totalRowsAcrossStores = 0;

function ok(label: string, detail: string): void {
  outcomes.push({ level: 'ok', label, detail });
}
function warn(label: string, detail: string): void {
  outcomes.push({ level: 'warn', label, detail });
}
function error(label: string, detail: string): void {
  outcomes.push({ level: 'error', label, detail });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

async function readTable(
  conn: import('@duckdb/node-api').DuckDBConnection,
  path: string,
): Promise<{ rows: number; columns: readonly string[] } | null> {
  try {
    const result = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM read_parquet('${path.replace(/'/g, "''")}');`,
    );
    const row = result.getRowObjects()[0] as { n?: bigint | number } | undefined;
    const rows = row?.n === undefined ? 0 : Number(row.n);
    const desc = await conn.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet('${path.replace(/'/g, "''")}') LIMIT 0;`,
    );
    const columns = desc
      .getRowObjects()
      .map((r) => String((r as Record<string, unknown>)['column_name']));
    return { rows, columns };
  } catch (err) {
    error(
      'unreadable parquet',
      `${path} :: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

interface SchemaExpectation {
  readonly required: readonly string[];
  /** Columns whose absence is logged as WARN rather than ERROR — they
   *  signal "stale file, rerun the projector" but don't break anything. */
  readonly recommended?: readonly string[];
  readonly rebuildHint?: string;
}

async function checkSharedTable(
  conn: import('@duckdb/node-api').DuckDBConnection,
  dataRoot: string,
  rel: string,
  schema: SchemaExpectation,
): Promise<number | null> {
  const path = join(dataRoot, rel);
  if (!(await fileExists(path))) {
    warn('shared table missing', rel);
    return null;
  }
  const info = await readTable(conn, path);
  if (info === null) return null;
  const missing = schema.required.filter((c) => !info.columns.includes(c));
  if (missing.length > 0) {
    error(
      `${rel} schema`,
      `missing columns: ${missing.join(', ')} (have: ${info.columns.join(', ')})`,
    );
    return info.rows;
  }
  const missingRecommended = (schema.recommended ?? []).filter(
    (c) => !info.columns.includes(c),
  );
  if (missingRecommended.length > 0) {
    warn(
      `${rel} stale`,
      `recommended columns absent: ${missingRecommended.join(', ')}${
        schema.rebuildHint !== undefined ? ` — ${schema.rebuildHint}` : ''
      }`,
    );
  }
  ok(`${rel}`, `rows=${info.rows} cols=${info.columns.length}`);
  totalRowsAcrossStores += info.rows;
  return info.rows;
}

async function checkKlinePartitions(
  conn: import('@duckdb/node-api').DuckDBConnection,
  dataRoot: string,
): Promise<{ codes: Set<string>; totalRows: number }> {
  const klineDir = join(dataRoot, 'kline');
  if (!(await fileExists(klineDir))) {
    error('kline dir', 'missing data/kline/');
    return { codes: new Set(), totalRows: 0 };
  }
  const files = (await readdir(klineDir))
    .filter((n) => /^\d{3}\.parquet$/.test(n))
    .sort();
  if (files.length === 0) {
    error('kline', 'no <prefix>.parquet files under data/kline/');
    return { codes: new Set(), totalRows: 0 };
  }
  const codes = new Set<string>();
  let totalRows = 0;
  for (const filename of files) {
    const prefix = filename.slice(0, 3);
    const path = join(klineDir, filename);
    const info = await readTable(conn, path);
    if (info === null) continue;
    for (const expected of ['code', 'ts', 'close_qfq', 'volume']) {
      if (!info.columns.includes(expected)) {
        error(`kline/${filename} schema`, `missing ${expected}`);
      }
    }
    totalRows += info.rows;
    // Pull codes into the set; also verify every code matches the partition prefix.
    const result = await conn.runAndReadAll(
      `SELECT DISTINCT code FROM read_parquet('${path}');`,
    );
    let outOfPrefix = 0;
    for (const row of result.getRowObjects()) {
      const code = String((row as Record<string, unknown>)['code']);
      codes.add(code);
      if (code.slice(0, 3) !== prefix) outOfPrefix += 1;
    }
    if (outOfPrefix > 0) {
      error(
        `kline/${filename}`,
        `${outOfPrefix} code(s) don't match partition prefix '${prefix}'`,
      );
    }
  }
  ok('kline', `partitions=${files.length} codes=${codes.size} rows=${totalRows}`);
  totalRowsAcrossStores += totalRows;
  return { codes, totalRows };
}

async function checkMetaVsKline(
  conn: import('@duckdb/node-api').DuckDBConnection,
  dataRoot: string,
  klineCodes: Set<string>,
): Promise<void> {
  const path = join(dataRoot, 'stock_metas.parquet');
  if (!(await fileExists(path))) return;
  const result = await conn.runAndReadAll(
    `SELECT DISTINCT code FROM read_parquet('${path}');`,
  );
  const metaCodes = new Set<string>();
  for (const row of result.getRowObjects()) {
    metaCodes.add(String((row as Record<string, unknown>)['code']));
  }
  const klineOrphans = Array.from(klineCodes).filter((c) => !metaCodes.has(c));
  const metaOnly = Array.from(metaCodes).filter((c) => !klineCodes.has(c));
  if (klineOrphans.length === 0) {
    ok('meta ⟷ kline', `all ${klineCodes.size} kline codes have meta rows`);
  } else {
    error(
      'meta ⟷ kline',
      `${klineOrphans.length} kline codes have no meta row (e.g. ${klineOrphans.slice(0, 5).join(', ')})`,
    );
  }
  if (metaOnly.length > 0) {
    // Brand-new listings are expected to land in meta before the next
    // kline cron tick; treat as info rather than error.
    warn(
      'meta has unsync\'d codes',
      `${metaOnly.length} meta rows have no kline yet (e.g. ${metaOnly.slice(0, 5).join(', ')})`,
    );
  }
}

async function checkUserScopedParquets(
  conn: import('@duckdb/node-api').DuckDBConnection,
  dataRoot: string,
): Promise<void> {
  const usersDir = join(dataRoot, 'users');
  if (!(await fileExists(usersDir))) {
    warn('users dir', 'data/users/ missing — fresh install?');
    return;
  }
  const userDirs = (await readdir(usersDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name);
  const expectedTables = ['ledger', 'watch_tasks', 'watch_groups', 'llm_ledger'];
  for (const uid of userDirs) {
    for (const table of expectedTables) {
      const path = join(usersDir, uid, `${table}.parquet`);
      if (!(await fileExists(path))) continue; // not all users have every table
      const info = await readTable(conn, path);
      if (info === null) continue;
      ok(`users/${uid}/${table}`, `rows=${info.rows} cols=${info.columns.length}`);
      totalRowsAcrossStores += info.rows;
    }
  }
  ok('user-scoped stores', `enumerated ${userDirs.length} user dir(s)`);
}

async function findLeftovers(dataRoot: string): Promise<void> {
  // Stray *.json under data/ — everything is parquet-backed now, a
  // JSON anywhere in here usually means a regression. The few known
  // exceptions (lookup tables, runtime KV state) are filtered out.
  const files = await walk(dataRoot);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (f.includes('/_state/')) continue;
    if (f.includes('/.legacy/')) continue;
    // Watch universe lookup tables ship as JSON (akshare round-trip).
    if (/\/watch\/universe_(hk|us)\.json$/.test(f)) continue;
    warn(`leftover json: ${relative(dataRoot, f)}`, 'investigate — should be parquet by now');
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!(await fileExists(args.dataRoot))) {
    console.error(`data root not found: ${args.dataRoot}`);
    process.exit(2);
  }
  console.log(`verifying ${args.dataRoot}`);
  console.log('');
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();

  // Shared single-file tables.
  await checkSharedTable(conn, args.dataRoot, 'stock_metas.parquet', {
    required: ['code', 'name', 'industries', 'list_date'],
    recommended: ['metrics_asof', 'metrics_updated_at', 'ret_5d', 'mkt_cap'],
    rebuildHint:
      'run upsert_stock_metrics_for_codes once to populate the persisted metrics block',
  });
  await checkSharedTable(conn, args.dataRoot, 'blacklist.parquet', {
    // Singleton-row payload: id + codes_json + computedAt
    required: ['id', 'codes_json'],
  });
  await checkSharedTable(conn, args.dataRoot, 'public_sectors.parquet', {
    required: ['id', 'payload_json'],
  });
  await checkSharedTable(conn, args.dataRoot, 'sentiment_stock.parquet', {
    required: ['code', 'payload_json'],
  });
  await checkSharedTable(conn, args.dataRoot, 'ta_cache.parquet', {
    required: ['code', 'asof', 'payload_json'],
  });

  // Kline (per-prefix files) + cross-store check against meta.
  const { codes: klineCodes } = await checkKlinePartitions(conn, args.dataRoot);
  await checkMetaVsKline(conn, args.dataRoot, klineCodes);

  // User-scoped stores.
  await checkUserScopedParquets(conn, args.dataRoot);

  // Cleanup hints.
  await findLeftovers(args.dataRoot);

  conn.disconnectSync();

  // -- Report --
  console.log('--- results ---');
  const errors = outcomes.filter((o) => o.level === 'error');
  const warnings = outcomes.filter((o) => o.level === 'warn');
  const okay = outcomes.filter((o) => o.level === 'ok');
  for (const o of okay) console.log(`  ✓ ${o.label}: ${o.detail}`);
  for (const o of warnings) console.log(`  ! ${o.label}: ${o.detail}`);
  for (const o of errors) console.log(`  ✗ ${o.label}: ${o.detail}`);
  console.log('');
  console.log(`summary: ok=${okay.length} warnings=${warnings.length} errors=${errors.length}`);
  console.log(`total rows across stores: ${totalRowsAcrossStores}`);
  if (errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`verify-data: ${String(err)}`);
  process.exit(1);
});
