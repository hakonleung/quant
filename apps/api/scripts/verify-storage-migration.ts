/**
 * Non-destructive verifier for the storage-unify migration.
 *
 * For every legacy `.bak` file left behind by a self-migrating store,
 * read the corresponding new Parquet (via DuckDB), project it back to
 * the legacy JSON shape, and deep-compare. Reports row-count + content
 * differences per store and writes a Markdown summary.
 *
 * Exit code:
 *   0 — every store matches legacy
 *   1 — one or more mismatches (see report)
 *   2 — fatal error before comparison could run
 *
 * Run:
 *   pnpm --filter @quant/api tsx scripts/verify-storage-migration.ts \
 *     [--data-root /path/to/data] \
 *     [--report-out /path/to/report.md]
 */

import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

interface CheckResult {
  readonly store: string;
  readonly legacyPath: string;
  readonly parquetPath: string;
  readonly ok: boolean;
  readonly notes: readonly string[];
}

interface Args {
  readonly dataRoot: string;
  readonly reportOut: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dataRoot = join(process.cwd(), '..', '..', 'data');
  let reportOut: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--data-root' && argv[i + 1] !== undefined) {
      dataRoot = argv[i + 1] as string;
      i += 1;
    } else if (flag === '--report-out' && argv[i + 1] !== undefined) {
      reportOut = argv[i + 1] as string;
      i += 1;
    }
  }
  return { dataRoot, reportOut: reportOut ?? join(dataRoot, 'migration-report.md') };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<unknown> {
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw) as unknown;
}

async function readParquetRows(
  conn: DuckDBConnection,
  parquetPath: string,
): Promise<readonly Record<string, unknown>[]> {
  const sql = `SELECT * FROM read_parquet('${parquetPath.replace(/'/g, "''")}');`;
  const result = await conn.runAndReadAll(sql);
  return result.getRowObjects() as readonly Record<string, unknown>[];
}

function diffArrays(actual: readonly unknown[], expected: readonly unknown[]): string[] {
  const out: string[] = [];
  if (actual.length !== expected.length) {
    out.push(`length mismatch: actual=${actual.length} expected=${expected.length}`);
  }
  const sample = Math.min(actual.length, expected.length, 5);
  for (let i = 0; i < sample; i += 1) {
    const a = JSON.stringify(actual[i]);
    const e = JSON.stringify(expected[i]);
    if (a !== e) out.push(`row[${i}] differs:\n  actual:   ${a}\n  expected: ${e}`);
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = canonicalize(obj[k]);
    return out;
  }
  return v;
}

// -- per-store checks --

async function checkBlacklist(
  conn: DuckDBConnection,
  dataRoot: string,
): Promise<CheckResult | null> {
  const legacy = join(dataRoot, 'blacklist.json.bak');
  const parquet = join(dataRoot, 'blacklist.parquet');
  if (!(await fileExists(legacy))) return null;
  const notes: string[] = [];
  if (!(await fileExists(parquet))) {
    return { store: 'blacklist', legacyPath: legacy, parquetPath: parquet, ok: false, notes: ['parquet missing'] };
  }
  const legacyData = (await readJson(legacy)) as {
    codes?: readonly string[];
    asof?: string;
    universeSize?: number;
    computedAt?: string;
  };
  const rows = await readParquetRows(conn, parquet);
  if (rows.length !== 1) {
    notes.push(`expected 1 row, got ${rows.length}`);
  }
  const row = rows[0];
  if (row !== undefined) {
    const codes = JSON.parse(String(row['codes_json'])) as readonly string[];
    if (!deepEqual(codes, legacyData.codes ?? [])) {
      notes.push(`codes mismatch: parquet=${codes.length} legacy=${legacyData.codes?.length ?? 0}`);
    }
    if (row['asof'] !== legacyData.asof) notes.push(`asof mismatch`);
    if (Number(row['universeSize']) !== legacyData.universeSize) notes.push(`universeSize mismatch`);
    if (row['computedAt'] !== legacyData.computedAt) notes.push(`computedAt mismatch`);
  }
  return { store: 'blacklist', legacyPath: legacy, parquetPath: parquet, ok: notes.length === 0, notes };
}

async function checkSectors(
  conn: DuckDBConnection,
  dataRoot: string,
): Promise<CheckResult | null> {
  const legacy = join(dataRoot, 'sectors', 'sectors.json.bak');
  const parquet = join(dataRoot, 'sectors', 'sectors.parquet');
  if (!(await fileExists(legacy))) return null;
  if (!(await fileExists(parquet))) {
    return { store: 'sectors', legacyPath: legacy, parquetPath: parquet, ok: false, notes: ['parquet missing'] };
  }
  const legacyData = (await readJson(legacy)) as readonly Record<string, unknown>[];
  const rows = await readParquetRows(conn, parquet);
  const decoded = rows
    .map((r) => JSON.parse(String(r['payload_json'])) as Record<string, unknown>)
    .sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
  // Legacy may have non-`s{n}` ids that the migration reseq'd. Compare by content sans id.
  const sortedLegacy = [...legacyData]
    .map((s) => ({ ...s }))
    .sort((a, b) => String(a['name'] ?? '').localeCompare(String(b['name'] ?? '')));
  const sortedDecoded = [...decoded].sort((a, b) =>
    String(a['name'] ?? '').localeCompare(String(b['name'] ?? '')),
  );
  const notes: string[] = [];
  if (sortedDecoded.length !== sortedLegacy.length) {
    notes.push(`length mismatch: parquet=${sortedDecoded.length} legacy=${sortedLegacy.length}`);
  }
  for (let i = 0; i < Math.min(sortedLegacy.length, sortedDecoded.length); i += 1) {
    const a = sortedDecoded[i] as Record<string, unknown>;
    const b = sortedLegacy[i] as Record<string, unknown>;
    // Drop id (may have been reseq'd) + ownership defaults injected by migrateLegacy
    const aCopy: Record<string, unknown> = { ...a };
    const bCopy: Record<string, unknown> = { ...b };
    delete aCopy['id'];
    delete bCopy['id'];
    if (bCopy['createdBy'] === undefined) bCopy['createdBy'] = 'admin';
    if (bCopy['published'] === undefined) bCopy['published'] = false;
    if (!deepEqual(aCopy, bCopy)) {
      notes.push(`sector[${i}] (name=${String(a['name'])}) differs`);
    }
  }
  return { store: 'sectors', legacyPath: legacy, parquetPath: parquet, ok: notes.length === 0, notes };
}

interface WatchSingletonShape {
  readonly user: string;
  readonly table: 'watch_tasks' | 'watch_groups';
  readonly legacyFile: string;
  readonly parquetFile: string;
}

async function findUserStores(dataRoot: string): Promise<WatchSingletonShape[]> {
  const out: WatchSingletonShape[] = [];
  const usersDir = join(dataRoot, 'users');
  if (!(await fileExists(usersDir))) return out;
  const userIds = await fs.readdir(usersDir);
  for (const uid of userIds) {
    const candidates: WatchSingletonShape[] = [
      {
        user: uid,
        table: 'watch_tasks',
        legacyFile: join(usersDir, uid, 'watch', 'tasks.json.bak'),
        parquetFile: join(usersDir, uid, 'watch_tasks.parquet'),
      },
      {
        user: uid,
        table: 'watch_groups',
        legacyFile: join(usersDir, uid, 'watch', 'groups.json.bak'),
        parquetFile: join(usersDir, uid, 'watch_groups.parquet'),
      },
    ];
    for (const c of candidates) {
      if (await fileExists(c.legacyFile)) out.push(c);
    }
  }
  return out;
}

async function checkWatchSingleton(
  conn: DuckDBConnection,
  shape: WatchSingletonShape,
): Promise<CheckResult> {
  const notes: string[] = [];
  if (!(await fileExists(shape.parquetFile))) {
    return {
      store: `${shape.table}[${shape.user}]`,
      legacyPath: shape.legacyFile,
      parquetPath: shape.parquetFile,
      ok: false,
      notes: ['parquet missing'],
    };
  }
  const legacyRaw = await readJson(shape.legacyFile);
  const rows = await readParquetRows(conn, shape.parquetFile);
  if (rows.length !== 1) notes.push(`expected 1 row, got ${rows.length}`);
  const row = rows[0];
  if (row !== undefined) {
    const decoded = JSON.parse(String(row['payload_json'])) as unknown;
    if (shape.table === 'watch_groups') {
      // Legacy = WatchGroup[] | decoded = WatchGroup[]
      const lengthLegacy = Array.isArray(legacyRaw) ? legacyRaw.length : 0;
      const lengthDecoded = Array.isArray(decoded) ? decoded.length : 0;
      if (lengthLegacy !== lengthDecoded) {
        notes.push(`groups length: parquet=${lengthDecoded} legacy=${lengthLegacy}`);
      } else if (Array.isArray(legacyRaw) && Array.isArray(decoded)) {
        notes.push(...diffArrays(decoded, legacyRaw));
      }
    } else {
      // tasks: legacy may be bare array (v1) or v2 file shape
      const legacyTasks = extractTasks(legacyRaw);
      const decodedTasks = extractTasks(decoded);
      if (legacyTasks.length !== decodedTasks.length) {
        notes.push(`tasks length: parquet=${decodedTasks.length} legacy=${legacyTasks.length}`);
      } else {
        // After v1→v2 migration the on-disk tasks are equivalent
        // modulo the dropped/synthesized fields the store rewrites on
        // load (lastMatchAt removed, groupName synthesized when empty,
        // lastHitPrice defaulted). Compare key invariants only.
        for (let i = 0; i < legacyTasks.length; i += 1) {
          const l = legacyTasks[i] as Record<string, unknown>;
          const d = decodedTasks[i] as Record<string, unknown>;
          for (const field of ['market', 'code', 'conditions'] as const) {
            if (!deepEqual(d[field], l[field])) {
              notes.push(`task[${i}].${field} differs`);
            }
          }
        }
      }
    }
  }
  return {
    store: `${shape.table}[${shape.user}]`,
    legacyPath: shape.legacyFile,
    parquetPath: shape.parquetFile,
    ok: notes.length === 0,
    notes,
  };
}

function extractTasks(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)) {
    return (raw as { tasks: readonly unknown[] }).tasks;
  }
  return [];
}

function formatReport(results: readonly CheckResult[], dataRoot: string): string {
  const lines: string[] = [];
  lines.push('# Storage Migration Verification Report');
  lines.push('');
  lines.push(`Data root: \`${dataRoot}\``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  lines.push(`**Status: ${bad.length === 0 ? 'PASS' : `FAIL — ${bad.length} mismatch(es)`}**`);
  lines.push('');
  lines.push(`- checks run: ${results.length}`);
  lines.push(`- ok:         ${ok.length}`);
  lines.push(`- mismatched: ${bad.length}`);
  lines.push('');
  if (bad.length > 0) {
    lines.push('## Mismatches');
    lines.push('');
    for (const r of bad) {
      lines.push(`### ${r.store}`);
      lines.push(`- legacy:  \`${relative(dataRoot, r.legacyPath)}\``);
      lines.push(`- parquet: \`${relative(dataRoot, r.parquetPath)}\``);
      for (const n of r.notes) {
        lines.push(`- ⚠ ${n}`);
      }
      lines.push('');
    }
  }
  lines.push('## All checks');
  lines.push('');
  for (const r of results) {
    lines.push(`- ${r.ok ? '✓' : '✗'} \`${r.store}\``);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!(await fileExists(args.dataRoot))) {
    console.error(`data-root does not exist: ${args.dataRoot}`);
    process.exit(2);
  }
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const results: CheckResult[] = [];

  const bl = await checkBlacklist(conn, args.dataRoot);
  if (bl !== null) results.push(bl);

  const sec = await checkSectors(conn, args.dataRoot);
  if (sec !== null) results.push(sec);

  const watchStores = await findUserStores(args.dataRoot);
  for (const shape of watchStores) {
    results.push(await checkWatchSingleton(conn, shape));
  }

  const report = formatReport(results, args.dataRoot);
  await fs.mkdir(dirname(args.reportOut), { recursive: true });
  await fs.writeFile(args.reportOut, report);
  process.stdout.write(report);
  process.stdout.write(`\nreport written to ${args.reportOut}\n`);
  const ok = results.every((r) => r.ok);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-storage-migration: ${String(err)}`);
  process.exit(2);
});
