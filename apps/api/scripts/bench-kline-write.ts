/**
 * Write-amplification benchmark for DuckDBParquetTimeSeriesStore.
 *
 * Production load: daily cron writes ~5500 rows (one per A-share code).
 * Distributed across 30-ish partitions, that's ~180 rows / partition /
 * delta. Compaction runs once per day.
 *
 * To measure read perf realistically we first need ~20 years of history
 * pre-loaded. We bypass appendBars for that (it would build a giant
 * VALUES SQL string) and have DuckDB generate the synthetic rows
 * directly inside the engine. The "cold backfill" path is what the
 * one-time migration script will use; daily writes go through
 * appendBars.
 */

import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DuckDBInstance } from '@duckdb/node-api';

import { DuckDBParquetTimeSeriesStore } from '../src/common/storage/adapters/duckdb-parquet-time-series.store.js';

interface Bar {
  code: string;
  ts: Date;
  open_qfq: number;
  high_qfq: number;
  low_qfq: number;
  close_qfq: number;
  volume: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
}

const COLUMNS = [
  { name: 'code', type: 'VARCHAR' as const, nullable: false },
  { name: 'ts', type: 'DATE' as const, nullable: false },
  { name: 'open_qfq', type: 'DOUBLE' as const },
  { name: 'high_qfq', type: 'DOUBLE' as const },
  { name: 'low_qfq', type: 'DOUBLE' as const },
  { name: 'close_qfq', type: 'DOUBLE' as const },
  { name: 'volume', type: 'BIGINT' as const },
  { name: 'ma5', type: 'DOUBLE' as const },
  { name: 'ma10', type: 'DOUBLE' as const },
  { name: 'ma20', type: 'DOUBLE' as const },
  { name: 'ma60', type: 'DOUBLE' as const },
];

const A_SHARE_PREFIXES = [
  '000',
  '001',
  '002',
  '003',
  '300',
  '301',
  '600',
  '601',
  '602',
  '603',
  '605',
  '688',
  '689',
  '830',
  '831',
  '832',
  '833',
  '834',
  '835',
  '836',
  '837',
  '838',
  '870',
  '871',
  '872',
  '873',
  '874',
];

function makeCodes(total: number): string[] {
  const codes: string[] = [];
  let i = 0;
  while (codes.length < total) {
    const prefix = A_SHARE_PREFIXES[i % A_SHARE_PREFIXES.length] ?? '000';
    const suffix = Math.floor(i / A_SHARE_PREFIXES.length)
      .toString()
      .padStart(3, '0');
    codes.push(`${prefix}${suffix}`);
    i += 1;
  }
  return codes;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) total += await dirBytes(p);
    else total += s.size;
  }
  return total;
}

async function partitionStats(root: string): Promise<{ partitions: number; files: number }> {
  let partitions = 0;
  let files = 0;
  let prefixes: string[] = [];
  try {
    prefixes = await readdir(root);
  } catch {
    return { partitions: 0, files: 0 };
  }
  for (const p of prefixes) {
    const list = await readdir(join(root, p)).catch(() => []);
    if (list.length > 0) partitions += 1;
    files += list.filter((f) => f.endsWith('.parquet')).length;
  }
  return { partitions, files };
}

async function main(): Promise<void> {
  const CODES = 5500;
  const DAYS = 5_000; // ~20 years of trading days
  const dir = await mkdtemp(join(tmpdir(), 'kline-bench-'));
  console.log(`bench dir: ${dir}`);
  try {
    // Step 1: generate synthetic backfill INSIDE DuckDB, write straight
    // to one main parquet per partition. This is the migration path,
    // not the appendBars path.
    console.log(`=== Cold backfill via DuckDB COPY: ${CODES} codes × ${DAYS} days ===`);
    const codes = makeCodes(CODES);
    const prefixes = Array.from(new Set(codes.map((c) => c.slice(0, 3)))).sort();
    console.log(`  partitions: ${prefixes.length}`);

    const inst = await DuckDBInstance.create(':memory:');
    const conn = await inst.connect();

    const tBackfill = performance.now();
    await conn.run(`
      CREATE TEMP TABLE codes (code VARCHAR);
      INSERT INTO codes VALUES ${codes.map((c) => `('${c}')`).join(', ')};
      CREATE TEMP TABLE bars AS
      SELECT
        c.code,
        DATE '2006-01-01' + INTERVAL (d.i) DAY AS ts,
        10 + random() AS open_qfq,
        10.5 + random() AS high_qfq,
        9.5 + random() AS low_qfq,
        10 + random() AS close_qfq,
        CAST(random() * 1000000 AS BIGINT) AS volume,
        10 + random() * 0.1 AS ma5,
        10 + random() * 0.1 AS ma10,
        10 + random() * 0.1 AS ma20,
        10 + random() * 0.1 AS ma60,
        substr(c.code, 1, 3) AS prefix
      FROM codes c CROSS JOIN range(${DAYS}) d(i);
    `);
    const tGenerated = performance.now();
    console.log(`  in-engine generation: ${Math.round(tGenerated - tBackfill)}ms`);

    // Write one main file per partition with hive partitioning, then
    // rename each into the LSM-expected name.
    const stage = join(dir, '_backfill_stage');
    await conn.run(`
      COPY (SELECT * FROM bars) TO '${stage}' (
        FORMAT PARQUET,
        PARTITION_BY (prefix),
        OVERWRITE_OR_IGNORE
      );
    `);
    const tStaged = performance.now();
    console.log(`  staged ${CODES * DAYS} rows: ${Math.round(tStaged - tGenerated)}ms`);

    // Relocate stage/prefix=XXX/<file>.parquet → <dir>/kline/XXX/00000000000000-main.parquet
    const stagedPrefixDirs = await readdir(stage);
    const klineRoot = join(dir, 'kline');
    for (const partName of stagedPrefixDirs) {
      const prefix = partName.replace('prefix=', '');
      const files = await readdir(join(stage, partName));
      const sourcesParquet = files.filter((f) => f.endsWith('.parquet'));
      // Merge multiple stage files into one main via COPY (rare; usually 1)
      const target = join(klineRoot, prefix, '00000000000000-main.parquet');
      await mkdir(join(klineRoot, prefix), { recursive: true });
      await conn.run(`
        COPY (
          SELECT code, ts, open_qfq, high_qfq, low_qfq, close_qfq, volume, ma5, ma10, ma20, ma60
          FROM read_parquet([${sourcesParquet
            .map((f) => `'${join(stage, partName, f)}'`)
            .join(', ')}])
        ) TO '${target}' (FORMAT PARQUET);
      `);
    }
    await rm(stage, { recursive: true, force: true });
    const tRelocated = performance.now();
    const backfillBytes = await dirBytes(klineRoot);
    const backfillCounts = await partitionStats(klineRoot);
    console.log(
      `  relocated to LSM layout: ${Math.round(tRelocated - tStaged)}ms, ` +
        `bytes=${Math.round(backfillBytes / 1e6)}MB, ` +
        `partitions=${backfillCounts.partitions}, files=${backfillCounts.files}`,
    );

    // Step 2: daily update via appendBars (5500 rows, one per code).
    const store = new DuckDBParquetTimeSeriesStore<Bar>({
      dataRoot: dir,
      table: 'kline',
      columns: COLUMNS,
    });
    const updateDate = new Date(Date.UTC(2026, 0, 1));
    const dailyBars: Bar[] = codes.map(
      (code) =>
        ({
          code,
          ts: updateDate,
          open_qfq: 11,
          high_qfq: 11.2,
          low_qfq: 10.8,
          close_qfq: 11.1,
          volume: 123456 as unknown as number,
          ma5: 11,
          ma10: 11,
          ma20: 11,
          ma60: 11,
        }) as unknown as Bar,
    );

    const tDaily0 = performance.now();
    await store.appendBars(dailyBars);
    const tDailyDone = performance.now();
    const afterDaily = await partitionStats(klineRoot);
    const afterDailyBytes = await dirBytes(klineRoot);
    console.log(
      `=== Daily update (${CODES} rows in one batch): ${Math.round(tDailyDone - tDaily0)}ms, ` +
        `delta files added=${afterDaily.files - backfillCounts.files}, ` +
        `bytes growth=${Math.round((afterDailyBytes - backfillBytes) / 1e3)}KB`,
    );

    // Simulate 10 intra-day batches (e.g., per-code retries trickle in)
    const tIntraStart = performance.now();
    for (let i = 0; i < 10; i += 1) {
      const slice = dailyBars.slice(i * 550, (i + 1) * 550);
      await store.appendBars(slice.map((b) => ({ ...b, close_qfq: 11.1 + i * 0.01 })));
    }
    const tIntraDone = performance.now();
    const afterIntra = await partitionStats(klineRoot);
    console.log(
      `=== 10 trickle batches (550 rows each): ${Math.round(tIntraDone - tIntraStart)}ms, ` +
        `delta file count now=${afterIntra.files - backfillCounts.files}`,
    );

    // Step 3: read benchmarks
    const sampleCode = codes[123] as string;
    const t1 = performance.now();
    const r1 = await store.read({ entityKeys: [sampleCode], tail: 30 });
    const t1d = performance.now();
    console.log(`single-code 30-bar tail: ${Math.round(t1d - t1)}ms, rows=${r1.length}`);

    const t2 = performance.now();
    const r2 = await store.read({
      entityKeys: codes.slice(0, 100),
      tail: 1,
    });
    const t2d = performance.now();
    console.log(`100-code latest: ${Math.round(t2d - t2)}ms, rows=${r2.length}`);

    const t3 = performance.now();
    const map = await store.lastTimestamps(codes);
    const t3d = performance.now();
    console.log(
      `universe lastTimestamps (${CODES} codes): ${Math.round(t3d - t3)}ms, mapped=${map.size}`,
    );

    // Step 4: compaction
    const tC0 = performance.now();
    await store.compact();
    const tCd = performance.now();
    const finalBytes = await dirBytes(klineRoot);
    const finalCounts = await partitionStats(klineRoot);
    console.log(
      `=== Full compaction: ${Math.round(tCd - tC0)}ms, ` +
        `bytes=${Math.round(finalBytes / 1e6)}MB, files=${finalCounts.files}`,
    );

    // Post-compact read
    const t4 = performance.now();
    const r4 = await store.read({ entityKeys: [sampleCode], tail: 30 });
    const t4d = performance.now();
    console.log(
      `post-compact single-code 30-bar tail: ${Math.round(t4d - t4)}ms, rows=${r4.length}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
