/**
 * Sweep `data/users/*\/` and consolidate the four legacy per-user
 * stores (`watch_groups.parquet`, `watch_tasks.parquet`, `ledger.parquet`,
 * `sys-cfg/sys-cfg.json`) into a single `user.parquet`. Also rewrites
 * `user_llm_ledger.parquet` in v2 form (drops `provider` / `cnyCost`
 * — see §4 in the data-normalization plan).
 *
 * Idempotent — re-running on a user that already has `user.parquet`
 * (and a v2 LLM ledger) is a no-op. Originals are moved to
 * `data/users/{uid}/.legacy/<filename>` instead of deleted; reverse
 * with `mv`.
 *
 * Run:
 *   pnpm --filter @quant/api tsx scripts/migrate-user-stores.ts \
 *     [--data-root /path/to/data] \
 *     [--dry-run]
 *
 * Exit code:
 *   0 — every user up-to-date (already migrated or migrated this run)
 *   1 — at least one user failed (see stderr)
 *   2 — fatal error before sweep started
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import {
  EMPTY_LEDGER_SLICE,
  EMPTY_WATCH_TASK_FILE,
  USER_BLOB_SCHEMA_VERSION,
  type LedgerSlice,
  type UserBlob,
  type WatchSlice,
} from '../src/common/storage/user-blob.types.js';
import { migrateLedgerPayload } from '../src/modules/llm/ledger/user-llm-ledger.types.js';
import {
  parseLedgerSlice,
  parseWatchGroupsArray,
} from '../src/common/storage/user-blob.store.js';
import { DEFAULT_SYS_CFG, SysCfgSchema, type SysCfg } from '@quant/shared';

interface Args {
  readonly dataRoot: string;
  readonly dryRun: boolean;
}

interface UserOutcome {
  readonly userId: string;
  readonly status: 'already' | 'migrated' | 'partial' | 'skipped' | 'failed';
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

async function readSingletonPayload(
  conn: DuckDBConnection,
  parquet: string,
): Promise<unknown | undefined> {
  if (!(await fileExists(parquet))) return undefined;
  const sql = `SELECT payload_json FROM read_parquet('${parquet.replace(/'/g, "''")}')`;
  try {
    const result = await conn.runAndReadAll(sql);
    const rows = result.getRowObjects() as readonly Record<string, unknown>[];
    const row = rows[0];
    if (row === undefined) return undefined;
    const raw = row['payload_json'];
    if (typeof raw !== 'string') return undefined;
    return JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`failed to read ${parquet}: ${String(err)}`);
  }
}

async function readLedgerRows(
  conn: DuckDBConnection,
  parquet: string,
): Promise<LedgerSlice | undefined> {
  if (!(await fileExists(parquet))) return undefined;
  const sql = `SELECT date, "pnlAmount", "closingPosition" FROM read_parquet('${parquet.replace(/'/g, "''")}') ORDER BY date ASC`;
  try {
    const result = await conn.runAndReadAll(sql);
    const rows = result.getRowObjects() as readonly Record<string, unknown>[];
    const entries = rows.map((r) => {
      const date = String(r['date']);
      const pnlAmount = String(r['pnlAmount']);
      const cp = r['closingPosition'];
      return cp === null || cp === undefined
        ? { date, pnlAmount }
        : { date, pnlAmount, closingPosition: String(cp) };
    });
    const parsed = parseLedgerSlice({ entries });
    return parsed;
  } catch (err: unknown) {
    throw new Error(`failed to read ${parquet}: ${String(err)}`);
  }
}

async function readSysCfg(file: string): Promise<SysCfg | undefined> {
  if (!(await fileExists(file))) return undefined;
  const raw = await fs.readFile(file, 'utf8');
  try {
    const parsed = SysCfgSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeSingletonParquet(
  conn: DuckDBConnection,
  parquet: string,
  payload: unknown,
): Promise<void> {
  const escaped = JSON.stringify(payload).replace(/'/g, "''");
  const tmp = `${parquet}.tmp`;
  const sql = `COPY (SELECT 'singleton' AS id, '${escaped}' AS payload_json) TO '${tmp.replace(/'/g, "''")}' (FORMAT PARQUET)`;
  await conn.runAndReadAll(sql);
  await fs.rename(tmp, parquet);
}

async function moveToLegacy(
  userDir: string,
  files: readonly string[],
): Promise<readonly string[]> {
  const legacyDir = join(userDir, '.legacy');
  const moved: string[] = [];
  for (const file of files) {
    const base = file.replace(`${userDir}/`, '');
    const dest = join(legacyDir, base);
    await fs.mkdir(join(dest, '..'), { recursive: true });
    try {
      await fs.rename(file, dest);
      moved.push(file);
    } catch (err: unknown) {
      throw new Error(`failed to archive ${file}: ${String(err)}`);
    }
  }
  return moved;
}

async function migrateOne(
  conn: DuckDBConnection,
  dataRoot: string,
  userId: string,
  dryRun: boolean,
): Promise<UserOutcome> {
  const userDir = join(dataRoot, 'users', userId);
  const userBlob = join(userDir, 'user.parquet');
  const llmLedger = join(userDir, 'user_llm_ledger.parquet');
  const watchGroups = join(userDir, 'watch_groups.parquet');
  const watchTasks = join(userDir, 'watch_tasks.parquet');
  const ledger = join(userDir, 'ledger.parquet');
  const sysCfgJson = join(userDir, 'sys-cfg', 'sys-cfg.json');

  const notes: string[] = [];
  const legacyToArchive: string[] = [];

  // --- user.parquet (consolidated) ---
  const haveUserBlob = await fileExists(userBlob);
  if (!haveUserBlob) {
    const groupsRaw = await readSingletonPayload(conn, watchGroups);
    const tasksRaw = await readSingletonPayload(conn, watchTasks);
    const ledgerSlice = await readLedgerRows(conn, ledger);
    const sysCfg = await readSysCfg(sysCfgJson);

    const haveAnyLegacy =
      groupsRaw !== undefined ||
      tasksRaw !== undefined ||
      ledgerSlice !== undefined ||
      sysCfg !== undefined;
    if (!haveAnyLegacy) {
      notes.push('no legacy files');
    } else {
      const groups = parseWatchGroupsArray(groupsRaw) ?? [];
      const tasks = parseTaskFile(tasksRaw);
      const watch: WatchSlice = { groups, tasks };
      const blob: UserBlob = {
        schemaVersion: USER_BLOB_SCHEMA_VERSION,
        watch,
        ledger: ledgerSlice ?? structuredClone(EMPTY_LEDGER_SLICE),
        sysCfg: sysCfg ?? structuredClone(DEFAULT_SYS_CFG),
      };
      if (!dryRun) {
        await writeSingletonParquet(conn, userBlob, blob);
        notes.push(`wrote user.parquet (groups=${groups.length} tasks=${tasks.tasks.length} ledger=${blob.ledger.entries.length})`);
      } else {
        notes.push(`[dry-run] would write user.parquet (groups=${groups.length} tasks=${tasks.tasks.length} ledger=${blob.ledger.entries.length})`);
      }
      if (groupsRaw !== undefined) legacyToArchive.push(watchGroups);
      if (tasksRaw !== undefined) legacyToArchive.push(watchTasks);
      if (ledgerSlice !== undefined) legacyToArchive.push(ledger);
      if (sysCfg !== undefined) legacyToArchive.push(sysCfgJson);
    }
  } else {
    notes.push('user.parquet already present');
  }

  // --- user_llm_ledger.parquet (slim v2 rewrite) ---
  if (await fileExists(llmLedger)) {
    const raw = await readSingletonPayload(conn, llmLedger);
    const migrated = migrateLedgerPayload(raw);
    if (migrated === null) {
      notes.push('llm_ledger payload unrecognized — skipped');
    } else {
      const before = entryFieldsHash(raw);
      const after = entryFieldsHash(migrated);
      if (before === after) {
        notes.push('llm_ledger already in v2 shape');
      } else if (!dryRun) {
        await writeSingletonParquet(conn, llmLedger, migrated);
        notes.push(`rewrote user_llm_ledger.parquet (entries=${migrated.entries.length})`);
      } else {
        notes.push(`[dry-run] would rewrite user_llm_ledger.parquet (entries=${migrated.entries.length})`);
      }
    }
  }

  // --- archive originals ---
  if (legacyToArchive.length > 0 && !dryRun) {
    await moveToLegacy(userDir, legacyToArchive);
    notes.push(`archived ${legacyToArchive.length} file(s) → .legacy/`);
  } else if (legacyToArchive.length > 0) {
    notes.push(`[dry-run] would archive ${legacyToArchive.length} file(s)`);
  }

  const status: UserOutcome['status'] = haveUserBlob && legacyToArchive.length === 0 ? 'already' : 'migrated';
  return { userId, status, notes };
}

function parseTaskFile(raw: unknown): WatchSlice['tasks'] {
  if (raw === null || raw === undefined) return structuredClone(EMPTY_WATCH_TASK_FILE);
  if (typeof raw !== 'object') return structuredClone(EMPTY_WATCH_TASK_FILE);
  const obj = raw as { version?: unknown; nextIdx?: unknown; tasks?: unknown };
  if (obj.version === 2 && Array.isArray(obj.tasks)) {
    const nextIdx =
      typeof obj.nextIdx === 'number' && Number.isInteger(obj.nextIdx) && obj.nextIdx >= 1
        ? obj.nextIdx
        : Math.max(
            1,
            ...obj.tasks
              .map((t) => (typeof t === 'object' && t !== null ? (t as { idx?: unknown }).idx : undefined))
              .filter((v): v is number => typeof v === 'number'),
          ) + 1;
    return { version: 2, nextIdx, tasks: obj.tasks as WatchSlice['tasks']['tasks'] };
  }
  if (Array.isArray(raw)) {
    return { version: 2, nextIdx: raw.length + 1, tasks: raw as WatchSlice['tasks']['tasks'] };
  }
  return structuredClone(EMPTY_WATCH_TASK_FILE);
}

function entryFieldsHash(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '';
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return '';
  const fieldSet = new Set<string>();
  for (const e of entries) {
    if (e !== null && typeof e === 'object') {
      for (const k of Object.keys(e)) fieldSet.add(k);
    }
  }
  return [...fieldSet].sort().join(',');
}

export async function runMigration(args: Args): Promise<readonly UserOutcome[]> {
  const usersDir = join(args.dataRoot, 'users');
  if (!(await fileExists(usersDir))) {
    return [];
  }
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  const ids = (await fs.readdir(usersDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const out: UserOutcome[] = [];
  for (const id of ids) {
    try {
      out.push(await migrateOne(conn, args.dataRoot, id, args.dryRun));
    } catch (err: unknown) {
      out.push({ userId: id, status: 'failed', notes: [String(err)] });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!(await fileExists(args.dataRoot))) {
    console.error(`data-root does not exist: ${args.dataRoot}`);
    process.exit(2);
  }
  console.log(`migrate-user-stores: dataRoot=${args.dataRoot} dryRun=${args.dryRun}`);
  const outcomes = await runMigration(args);
  let failed = 0;
  for (const o of outcomes) {
    const tag = o.status === 'failed' ? 'FAIL' : o.status.toUpperCase();
    console.log(`[${tag}] ${o.userId}`);
    for (const n of o.notes) console.log(`        ${n}`);
    if (o.status === 'failed') failed += 1;
  }
  console.log(`\nsweep complete: ${outcomes.length} user(s), ${failed} failure(s)`);
  process.exit(failed > 0 ? 1 : 0);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('migrate-user-stores.ts');
if (isMain) {
  main().catch((err) => {
    console.error(`migrate-user-stores fatal: ${String(err)}`);
    process.exit(2);
  });
}
