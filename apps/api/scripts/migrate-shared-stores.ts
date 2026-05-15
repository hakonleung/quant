/**
 * One-shot sweep that adopts every legacy per-code JSON cache into its
 * canonical parquet table. Complements `migrate-user-stores.ts` (which
 * handles `data/users/{uid}/` state) — this script handles the three
 * system-wide JSON caches that pre-date storage-unify:
 *
 *   data/sentiment/stock/{code}.json        → data/sentiment_stock.parquet
 *   data/sentiment/market/{codeHash}.json   → data/sentiment_market.parquet
 *   data/ta/{code}.json                     → data/ta_cache.parquet
 *
 * Each live store has a `tryAdoptLegacy` hook that runs on-demand when
 * a missing code is requested. This script sweeps the lot in one pass
 * so we don't leave half-migrated state sitting around. Originals
 * archived to `data/.legacy/<original-relative-path>`.
 *
 * Idempotent: re-running on an already-swept dir is a no-op.
 *
 * Run:
 *   pnpm --filter @quant/api tsx scripts/migrate-shared-stores.ts \
 *     [--data-root /path/to/data] [--dry-run]
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

interface Args {
  readonly dataRoot: string;
  readonly dryRun: boolean;
}

interface SweepOutcome {
  readonly table: string;
  readonly read: number;
  readonly written: number;
  readonly archived: number;
  readonly skipped: number;
  readonly notes: readonly string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dataRoot = join(process.cwd(), '..', '..', 'data');
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--data-root' && argv[i + 1] !== undefined) {
      dataRoot = argv[i + 1] as string;
      i += 1;
    } else if (flag === '--dry-run') {
      dryRun = true;
    }
  }
  return { dataRoot, dryRun };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(p: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function moveToLegacy(file: string, dataRoot: string): Promise<void> {
  const rel = relative(dataRoot, file);
  const dest = join(dataRoot, '.legacy', rel);
  await fs.mkdir(dirname(dest), { recursive: true });
  await fs.rename(file, dest);
}

interface RowKv {
  readonly columns: readonly string[];
  readonly values: readonly (string | number)[];
}

async function writeParquet(
  conn: DuckDBConnection,
  parquet: string,
  rows: readonly RowKv[],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = rows[0]!.columns;
  // Compose a single COPY statement: SELECT ... FROM (VALUES ...)
  const valueLits = rows
    .map(
      (r) =>
        '(' +
        r.values
          .map((v) =>
            typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`,
          )
          .join(', ') +
        ')',
    )
    .join(', ');
  const colList = cols.map((c) => `"${c}"`).join(', ');
  await fs.mkdir(dirname(parquet), { recursive: true });
  const tmp = `${parquet}.tmp`;
  await conn.runAndReadAll(
    `COPY (SELECT * FROM (VALUES ${valueLits}) AS t(${colList})) TO '${tmp.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
  await fs.rename(tmp, parquet);
}

/**
 * If `parquet` already exists, read its rows and merge with `extra` so
 * the sweep is additive (doesn't clobber what the live store has).
 */
async function mergeWithExisting(
  conn: DuckDBConnection,
  parquet: string,
  extra: readonly RowKv[],
  pkColumn: string,
): Promise<readonly RowKv[]> {
  if (!(await fileExists(parquet))) return extra;
  if (extra.length === 0) return extra;
  const cols = extra[0]!.columns;
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const result = await conn.runAndReadAll(
    `SELECT ${colList} FROM read_parquet('${parquet.replace(/'/g, "''")}')`,
  );
  const existing = result.getRowObjects() as readonly Record<string, unknown>[];
  const byPk = new Map<string, RowKv>();
  for (const row of existing) {
    const values = cols.map((c) => row[c] as string | number);
    const pk = String(row[pkColumn]);
    byPk.set(pk, { columns: cols, values });
  }
  // Extra wins on conflict (newer in legacy json = the rare manual import case).
  for (const row of extra) {
    const pkIdx = cols.indexOf(pkColumn);
    const pk = String(row.values[pkIdx]);
    byPk.set(pk, row);
  }
  return Array.from(byPk.values());
}

// ── sentiment_stock ────────────────────────────────────────────────────

async function sweepSentimentStock(
  conn: DuckDBConnection,
  args: Args,
): Promise<SweepOutcome> {
  const legacyDir = join(args.dataRoot, 'sentiment', 'stock');
  const parquet = join(args.dataRoot, 'sentiment_stock.parquet');
  const notes: string[] = [];
  let read = 0;
  let skipped = 0;
  let archivedCount = 0;
  const rows: RowKv[] = [];
  const toArchive: string[] = [];
  if (!(await fileExists(legacyDir))) {
    return { table: 'sentiment_stock', read, written: 0, archived: 0, skipped, notes: ['no legacy dir'] };
  }
  const entries = (await fs.readdir(legacyDir)).filter((f) => f.endsWith('.json'));
  for (const file of entries) {
    const full = join(legacyDir, file);
    read += 1;
    const raw = await readJsonSafe(full);
    if (raw === null || typeof raw !== 'object') {
      skipped += 1;
      notes.push(`${file} parse-failed`);
      continue;
    }
    const obj = raw as { windowDays?: unknown; value?: unknown };
    if (typeof obj.windowDays !== 'number') {
      skipped += 1;
      notes.push(`${file} missing windowDays`);
      continue;
    }
    if (obj.value === null || typeof obj.value !== 'object') {
      skipped += 1;
      notes.push(`${file} missing value`);
      continue;
    }
    const value = obj.value as { code?: unknown };
    if (typeof value.code !== 'string') {
      skipped += 1;
      notes.push(`${file} missing code`);
      continue;
    }
    rows.push({
      columns: ['code', 'windowDays', 'payload_json'],
      values: [value.code, obj.windowDays, JSON.stringify(obj.value)],
    });
    toArchive.push(full);
  }
  if (rows.length === 0) {
    return { table: 'sentiment_stock', read, written: 0, archived: 0, skipped, notes };
  }
  const merged = await mergeWithExisting(conn, parquet, rows, 'code');
  if (!args.dryRun) {
    await writeParquet(conn, parquet, merged);
    for (const f of toArchive) {
      await moveToLegacy(f, args.dataRoot);
    }
    archivedCount = toArchive.length;
  } else {
    notes.push(`[dry-run] would write ${merged.length} rows + archive ${toArchive.length} json(s)`);
  }
  return {
    table: 'sentiment_stock',
    read,
    written: args.dryRun ? 0 : merged.length,
    archived: archivedCount,
    skipped,
    notes,
  };
}

// ── sentiment_market ───────────────────────────────────────────────────

async function sweepSentimentMarket(
  conn: DuckDBConnection,
  args: Args,
): Promise<SweepOutcome> {
  const legacyDir = join(args.dataRoot, 'sentiment', 'market');
  const parquet = join(args.dataRoot, 'sentiment_market.parquet');
  const notes: string[] = [];
  let read = 0;
  let skipped = 0;
  let archivedCount = 0;
  const rows: RowKv[] = [];
  const toArchive: string[] = [];
  if (!(await fileExists(legacyDir))) {
    return { table: 'sentiment_market', read, written: 0, archived: 0, skipped, notes: ['no legacy dir'] };
  }
  const entries = (await fs.readdir(legacyDir)).filter((f) => f.endsWith('.json'));
  for (const file of entries) {
    const full = join(legacyDir, file);
    read += 1;
    const raw = await readJsonSafe(full);
    if (raw === null || typeof raw !== 'object') {
      skipped += 1;
      continue;
    }
    const obj = raw as { windowDays?: unknown; value?: unknown };
    if (typeof obj.windowDays !== 'number') {
      skipped += 1;
      continue;
    }
    if (obj.value === null || typeof obj.value !== 'object') {
      skipped += 1;
      continue;
    }
    const value = obj.value as { codeHash?: unknown };
    if (typeof value.codeHash !== 'string') {
      skipped += 1;
      continue;
    }
    rows.push({
      columns: ['codeHash', 'windowDays', 'payload_json'],
      values: [value.codeHash, obj.windowDays, JSON.stringify(obj.value)],
    });
    toArchive.push(full);
  }
  if (rows.length === 0) {
    return { table: 'sentiment_market', read, written: 0, archived: 0, skipped, notes };
  }
  const merged = await mergeWithExisting(conn, parquet, rows, 'codeHash');
  if (!args.dryRun) {
    await writeParquet(conn, parquet, merged);
    for (const f of toArchive) {
      await moveToLegacy(f, args.dataRoot);
    }
    archivedCount = toArchive.length;
  } else {
    notes.push(`[dry-run] would write ${merged.length} rows + archive ${toArchive.length} json(s)`);
  }
  return {
    table: 'sentiment_market',
    read,
    written: args.dryRun ? 0 : merged.length,
    archived: archivedCount,
    skipped,
    notes,
  };
}

// ── ta_cache ───────────────────────────────────────────────────────────

async function sweepTaCache(conn: DuckDBConnection, args: Args): Promise<SweepOutcome> {
  const legacyDir = join(args.dataRoot, 'ta');
  const parquet = join(args.dataRoot, 'ta_cache.parquet');
  const notes: string[] = [];
  let read = 0;
  let skipped = 0;
  let archivedCount = 0;
  const rows: RowKv[] = [];
  const toArchive: string[] = [];
  if (!(await fileExists(legacyDir))) {
    return { table: 'ta_cache', read, written: 0, archived: 0, skipped, notes: ['no legacy dir'] };
  }
  const entries = (await fs.readdir(legacyDir)).filter((f) => f.endsWith('.json'));
  for (const file of entries) {
    const full = join(legacyDir, file);
    read += 1;
    const raw = await readJsonSafe(full);
    if (raw === null || typeof raw !== 'object') {
      skipped += 1;
      continue;
    }
    // TA JSONs store the TaAnalysis directly (no wrapper).
    const value = raw as { code?: unknown; asof?: unknown };
    if (typeof value.code !== 'string' || typeof value.asof !== 'string') {
      skipped += 1;
      continue;
    }
    rows.push({
      columns: ['code', 'asof', 'payload_json'],
      values: [value.code, value.asof, JSON.stringify(raw)],
    });
    toArchive.push(full);
  }
  if (rows.length === 0) {
    return { table: 'ta_cache', read, written: 0, archived: 0, skipped, notes };
  }
  const merged = await mergeWithExisting(conn, parquet, rows, 'code');
  if (!args.dryRun) {
    await writeParquet(conn, parquet, merged);
    for (const f of toArchive) {
      await moveToLegacy(f, args.dataRoot);
    }
    archivedCount = toArchive.length;
  } else {
    notes.push(`[dry-run] would write ${merged.length} rows + archive ${toArchive.length} json(s)`);
  }
  return {
    table: 'ta_cache',
    read,
    written: args.dryRun ? 0 : merged.length,
    archived: archivedCount,
    skipped,
    notes,
  };
}

export async function runMigration(args: Args): Promise<readonly SweepOutcome[]> {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  return [
    await sweepSentimentStock(conn, args),
    await sweepSentimentMarket(conn, args),
    await sweepTaCache(conn, args),
  ];
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!(await fileExists(args.dataRoot))) {
    console.error(`data-root does not exist: ${args.dataRoot}`);
    process.exit(2);
  }
  console.log(`migrate-shared-stores: dataRoot=${args.dataRoot} dryRun=${args.dryRun}`);
  const outcomes = await runMigration(args);
  for (const o of outcomes) {
    console.log(
      `[${o.table}] read=${o.read} written=${o.written} archived=${o.archived} skipped=${o.skipped}`,
    );
    for (const n of o.notes) console.log(`        ${n}`);
  }
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('migrate-shared-stores.ts');
if (isMain) {
  main().catch((err) => {
    console.error(`migrate-shared-stores fatal: ${String(err)}`);
    process.exit(2);
  });
}
