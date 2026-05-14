/**
 * One-shot import: legacy `data/kline/{code}.parquet` (one file per
 * stock, ~5500 files, `Decimal(20,4)` columns) → new flat layout
 * `data/kline/{prefix}.parquet` (~13 files, `DOUBLE`).
 *
 * Strategy (mirrors the LSM compaction path, just sourced from legacy
 * files instead of deltas):
 *
 *   1. For each 3-digit prefix, scan the matching legacy `{code}.parquet`
 *      files via DuckDB `read_parquet(['p1', 'p2', ...])`.
 *   2. `COPY ... TO 'tmp.parquet'` with the canonical column projection
 *      and `Decimal → DOUBLE` casts.
 *   3. Rename the tmp file into `data/kline.new/{prefix}.parquet`.
 *   4. After all partitions land, surface a summary (rows per partition,
 *      bytes per partition).
 *
 * The script never touches the legacy `data/kline/*.parquet` files. The
 * caller swaps directories manually when verification looks good:
 *
 *     mv data/kline data/kline.bak
 *     mv data/kline.new data/kline
 *
 * Run:
 *   pnpm --filter @quant/api tsx scripts/import-kline-legacy.ts \
 *     [--data-root /path/to/data] \
 *     [--limit 200]
 */

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DuckDBInstance } from '@duckdb/node-api';

interface Args {
  readonly dataRoot: string;
  /** If set, only the first N legacy files (sorted) get imported. */
  readonly limit: number | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dataRoot = join(process.cwd(), '..', '..', 'data');
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--data-root' && argv[i + 1] !== undefined) {
      dataRoot = argv[i + 1] as string;
      i += 1;
    } else if (flag === '--limit' && argv[i + 1] !== undefined) {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit must be a positive number`);
      limit = n;
      i += 1;
    }
  }
  return { dataRoot, limit };
}

interface PartitionSummary {
  readonly prefix: string;
  readonly sourceFiles: number;
  readonly rows: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

const COLUMN_PROJECTION = `
  code,
  trade_date AS ts,
  CAST(open_qfq AS DOUBLE) AS open_qfq,
  CAST(high_qfq AS DOUBLE) AS high_qfq,
  CAST(low_qfq AS DOUBLE) AS low_qfq,
  CAST(close_qfq AS DOUBLE) AS close_qfq,
  CAST(volume AS BIGINT) AS volume,
  CAST(amount AS DOUBLE) AS amount,
  CAST(turnover_rate AS DOUBLE) AS turnover_rate,
  CAST(ma5 AS DOUBLE) AS ma5,
  CAST(ma10 AS DOUBLE) AS ma10,
  CAST(ma20 AS DOUBLE) AS ma20,
  CAST(ma60 AS DOUBLE) AS ma60
`;

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function listLegacyFiles(legacyDir: string, limit: number | null): Promise<string[]> {
  const names = await readdir(legacyDir);
  const filtered = names
    .filter((n) => /^\d{6}\.parquet$/.test(n))
    .sort();
  return limit === null ? filtered : filtered.slice(0, limit);
}

function groupByPrefix(filenames: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const filename of filenames) {
    const code = filename.slice(0, 6);
    const prefix = code.slice(0, 3);
    let bucket = out.get(prefix);
    if (bucket === undefined) {
      bucket = [];
      out.set(prefix, bucket);
    }
    bucket.push(filename);
  }
  return out;
}

async function importPartition(opts: {
  legacyDir: string;
  newRoot: string;
  prefix: string;
  filenames: readonly string[];
}): Promise<PartitionSummary> {
  const startedAt = performance.now();
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();

  const sourcePaths = opts.filenames.map((f) => join(opts.legacyDir, f));
  const sourceList = sourcePaths.map((p) => quoteLiteral(p)).join(', ');

  await mkdir(opts.newRoot, { recursive: true });
  const target = join(opts.newRoot, `${opts.prefix}.parquet`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;

  try {
    await conn.run(`
      COPY (
        SELECT ${COLUMN_PROJECTION}
        FROM read_parquet([${sourceList}])
        ORDER BY code, ts
      ) TO ${quoteLiteral(tmp)} (FORMAT PARQUET);
    `);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  const countResult = await conn.runAndReadAll(
    `SELECT count(*) AS n FROM read_parquet(${quoteLiteral(target)});`,
  );
  const rowsRaw = (countResult.getRowObjects()[0] as Record<string, unknown> | undefined)?.['n'];
  const rows = typeof rowsRaw === 'bigint' ? Number(rowsRaw) : Number(rowsRaw ?? 0);
  const { size } = await stat(target);

  conn.disconnectSync();

  return {
    prefix: opts.prefix,
    sourceFiles: opts.filenames.length,
    rows,
    bytes: size,
    elapsedMs: performance.now() - startedAt,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const legacyDir = join(args.dataRoot, 'kline');
  const newRoot = join(args.dataRoot, 'kline.new');

  if (!(await fileExists(legacyDir))) {
    console.error(`legacy kline dir missing: ${legacyDir}`);
    process.exit(2);
  }
  if (await fileExists(newRoot)) {
    console.error(`new layout dir already exists; remove or move first: ${newRoot}`);
    process.exit(2);
  }
  await mkdir(newRoot, { recursive: true });
  await mkdir(dirname(newRoot), { recursive: true });

  const files = await listLegacyFiles(legacyDir, args.limit);
  console.log(`legacy files to import: ${files.length}${args.limit === null ? '' : ` (limited)`}`);
  const groups = groupByPrefix(files);
  console.log(`target partitions: ${groups.size}`);

  const summaries: PartitionSummary[] = [];
  const overallStart = performance.now();
  for (const [prefix, filenames] of Array.from(groups.entries()).sort()) {
    const summary = await importPartition({ legacyDir, newRoot, prefix, filenames });
    summaries.push(summary);
    console.log(
      `[${prefix}] ${summary.sourceFiles.toString().padStart(4)} files → ` +
        `${summary.rows.toString().padStart(8)} rows, ` +
        `${(summary.bytes / 1024 / 1024).toFixed(1).padStart(6)} MB, ` +
        `${Math.round(summary.elapsedMs).toString().padStart(5)} ms`,
    );
  }
  const totalRows = summaries.reduce((a, s) => a + s.rows, 0);
  const totalBytes = summaries.reduce((a, s) => a + s.bytes, 0);
  const elapsed = performance.now() - overallStart;
  console.log('');
  console.log(`done: ${groups.size} partitions, ${totalRows} rows, ` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} MB, ${Math.round(elapsed)} ms total`);

  console.log('');
  console.log('verifying row counts per code…');
  const mismatches = await verifyRowCounts(legacyDir, newRoot, files);
  if (mismatches.length === 0) {
    console.log(`✓ all ${files.length} codes have matching row counts`);
  } else {
    console.log(`✗ ${mismatches.length} row-count mismatch(es):`);
    for (const m of mismatches.slice(0, 20)) {
      console.log(`    ${m.code}: legacy=${m.legacy} new=${m.newCount}`);
    }
    process.exitCode = 1;
  }

  console.log('');
  console.log(`output: ${newRoot}`);
  console.log('next: verify output, then');
  console.log(`  mv ${legacyDir} ${legacyDir}.bak && mv ${newRoot} ${legacyDir}`);
}

interface RowCountMismatch {
  readonly code: string;
  readonly legacy: number;
  readonly newCount: number;
}

async function verifyRowCounts(
  legacyDir: string,
  newRoot: string,
  files: readonly string[],
): Promise<RowCountMismatch[]> {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const legacyByCode = new Map<string, number>();
  for (const filename of files) {
    const code = filename.slice(0, 6);
    const path = join(legacyDir, filename);
    const r = await conn.runAndReadAll(
      `SELECT count(*) AS n FROM read_parquet(${quoteLiteral(path)});`,
    );
    const row = r.getRowObjects()[0] as { n?: bigint | number } | undefined;
    const raw = row?.n ?? 0;
    legacyByCode.set(code, typeof raw === 'bigint' ? Number(raw) : Number(raw));
  }
  const newGlob = join(newRoot, '*.parquet');
  const newAll = await conn.runAndReadAll(`
    SELECT code, count(*) AS n
    FROM read_parquet(${quoteLiteral(newGlob)})
    GROUP BY code;
  `);
  const newByCode = new Map<string, number>();
  for (const row of newAll.getRowObjects()) {
    const code = String((row as Record<string, unknown>)['code']);
    const raw = (row as Record<string, unknown>)['n'];
    newByCode.set(code, typeof raw === 'bigint' ? Number(raw) : Number(raw));
  }
  conn.disconnectSync();

  const out: RowCountMismatch[] = [];
  for (const [code, legacy] of legacyByCode) {
    const newCount = newByCode.get(code) ?? 0;
    if (newCount !== legacy) {
      out.push({ code, legacy, newCount });
    }
  }
  return out;
}

main().catch((err) => {
  console.error(`import-kline-legacy: ${String(err)}`);
  process.exit(1);
});
