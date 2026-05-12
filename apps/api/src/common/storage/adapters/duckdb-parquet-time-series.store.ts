/**
 * `TimeSeriesStore` backed by DuckDB + partitioned Parquet with an
 * LSM-style layout:
 *
 *   <dataRoot>/<table>/<prefix>/
 *     00000000000000-main.parquet       # compacted snapshot
 *     20260512143000-001-delta.parquet  # append since last compaction
 *     20260512143005-002-delta.parquet
 *     ...
 *
 * - Writes only ever generate new `*-delta.parquet` files (no rewrite of
 *   main). Per-partition mutex serialises just the rename step.
 * - Reads glob the partition dir and run
 *     QUALIFY row_number() OVER (PARTITION BY code, ts ORDER BY filename DESC) = 1
 *   so newer deltas mask older rows for the same `(code, ts)` (correct
 *   for late-arriving adjustment-factor changes).
 * - Compaction merges main + deltas into a fresh main and deletes the
 *   deltas it observed before the merge; new deltas that arrived during
 *   compaction (impossible while we hold the write mutex, but kept as
 *   defence in depth) are preserved.
 */

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';

import type { RecordColumnSpec } from '../ports/record-store.port.js';
import type {
  TimeSeriesReadQuery,
  TimeSeriesStore,
} from '../ports/time-series-store.port.js';

export interface DuckDBParquetTimeSeriesStoreOptions {
  readonly dataRoot: string;
  readonly table: string;
  /** Column declarations; the row type `Row` must structurally match. */
  readonly columns: readonly RecordColumnSpec[];
  /** Maps a `code` to a partition key — defaults to first 3 characters. */
  readonly partitionKey?: (code: string) => string;
  /** Default `Row` type assumes `code: string; ts: Date`; rename if needed. */
  readonly codeColumn?: string;
  readonly tsColumn?: string;
}

const DEFAULT_PARTITION_KEY = (code: string): string => code.slice(0, 3);
const MAIN_FILENAME = '00000000000000-main.parquet';

let writeSeq = 0;

export class DuckDBParquetTimeSeriesStore<Row extends { code: string; ts: Date }>
  implements TimeSeriesStore<Row>
{
  private connPromise: Promise<DuckDBConnection> | null = null;
  private readonly partitionMutex = new Map<string, Promise<unknown>>();
  private readonly partitionKey: (code: string) => string;
  private readonly codeColumn: string;
  private readonly tsColumn: string;
  private readonly tableRoot: string;

  constructor(private readonly opts: DuckDBParquetTimeSeriesStoreOptions) {
    this.partitionKey = opts.partitionKey ?? DEFAULT_PARTITION_KEY;
    this.codeColumn = opts.codeColumn ?? 'code';
    this.tsColumn = opts.tsColumn ?? 'ts';
    this.tableRoot = join(opts.dataRoot, opts.table);
  }

  private async connection(): Promise<DuckDBConnection> {
    if (this.connPromise === null) {
      this.connPromise = (async () => {
        const inst = await DuckDBInstance.create(':memory:');
        return inst.connect();
      })();
    }
    return this.connPromise;
  }

  async appendBars(rows: readonly Row[]): Promise<void> {
    if (rows.length === 0) return;
    const groups = this.groupByPartition(rows);
    await Promise.all(
      Array.from(groups.entries()).map(([prefix, group]) =>
        this.withPartitionLock(prefix, () => this.writeDelta(prefix, group)),
      ),
    );
  }

  async read(query: TimeSeriesReadQuery<Row>): Promise<readonly Row[]> {
    const prefixes = await this.resolvePrefixes(query.entityKeys);
    if (prefixes.length === 0) return [];
    const sql = await this.buildReadSql(prefixes, query);
    if (sql === null) return [];
    const conn = await this.connection();
    const result = await conn.runAndReadAll(sql);
    return result
      .getRowObjects()
      .map((r) => this.parseRow(r as Record<string, unknown>, query.columns));
  }

  async lastTimestamp(entityKey: string): Promise<Date | null> {
    const map = await this.lastTimestamps([entityKey]);
    return map.get(entityKey) ?? null;
  }

  async lastTimestamps(entityKeys: readonly string[]): Promise<ReadonlyMap<string, Date>> {
    if (entityKeys.length === 0) return new Map();
    const prefixes = await this.resolvePrefixes(entityKeys);
    if (prefixes.length === 0) return new Map();
    const conn = await this.connection();
    const codeList = entityKeys.map((c) => quoteLiteral(c)).join(', ');
    const out = new Map<string, Date>();
    for (const prefix of prefixes) {
      const glob = this.partitionGlob(prefix);
      const exists = await this.partitionHasFiles(prefix);
      if (!exists) continue;
      const sql = `
        WITH ranked AS (
          SELECT ${quoteIdent(this.codeColumn)} AS code, ${quoteIdent(this.tsColumn)} AS ts
          FROM read_parquet(${quoteLiteral(glob)}, filename=true)
          WHERE ${quoteIdent(this.codeColumn)} IN (${codeList})
        )
        SELECT code, max(ts) AS last_ts FROM ranked GROUP BY code;
      `;
      const result = await conn.runAndReadAll(sql);
      for (const row of result.getRowObjects()) {
        const obj = row as Record<string, unknown>;
        const code = String(obj['code']);
        const ts = normalizeDate(obj['last_ts']);
        if (ts !== null) {
          const existing = out.get(code);
          if (existing === undefined || ts.getTime() > existing.getTime()) {
            out.set(code, ts);
          }
        }
      }
    }
    return out;
  }

  async compact(partitionKey?: string): Promise<void> {
    const prefixes =
      partitionKey !== undefined ? [partitionKey] : await this.listExistingPrefixes();
    for (const prefix of prefixes) {
      await this.withPartitionLock(prefix, () => this.compactPartition(prefix));
    }
  }

  /** Visible for tests. */
  async listExistingPrefixes(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.tableRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private groupByPartition(rows: readonly Row[]): Map<string, Row[]> {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const prefix = this.partitionKey(row.code);
      let bucket = groups.get(prefix);
      if (bucket === undefined) {
        bucket = [];
        groups.set(prefix, bucket);
      }
      bucket.push(row);
    }
    return groups;
  }

  private async writeDelta(prefix: string, rows: readonly Row[]): Promise<void> {
    const dir = join(this.tableRoot, prefix);
    await mkdir(dir, { recursive: true });
    writeSeq += 1;
    const stamp = formatTimestamp(new Date());
    const seq = String(writeSeq).padStart(6, '0');
    const target = join(dir, `${stamp}-${seq}-delta.parquet`);
    const tmp = `${target}.tmp`;
    const conn = await this.connection();
    const colNames = this.opts.columns.map((c) => c.name);
    const colList = colNames.map(quoteIdent).join(', ');
    const rowsSql = rows
      .map((row) => {
        const obj = row as unknown as Record<string, unknown>;
        return `(${colNames.map((c) => quoteLiteral(obj[c])).join(', ')})`;
      })
      .join(', ');
    const sql = `
      COPY (SELECT * FROM (VALUES ${rowsSql}) AS t(${colList}))
      TO ${quoteLiteral(tmp)} (FORMAT PARQUET);
    `;
    try {
      await conn.run(sql);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async buildReadSql(
    prefixes: readonly string[],
    query: TimeSeriesReadQuery<Row>,
  ): Promise<string | null> {
    const validPrefixes: string[] = [];
    for (const prefix of prefixes) {
      if (await this.partitionHasFiles(prefix)) validPrefixes.push(prefix);
    }
    if (validPrefixes.length === 0) return null;
    const cols =
      query.columns !== undefined
        ? query.columns.map((c) => quoteIdent(c as string)).join(', ')
        : this.opts.columns.map((c) => quoteIdent(c.name)).join(', ');
    const filterClauses: string[] = [];
    if (query.entityKeys !== undefined) {
      const inList = query.entityKeys.map((c) => quoteLiteral(c)).join(', ');
      filterClauses.push(`${quoteIdent(this.codeColumn)} IN (${inList})`);
    }
    if (query.start !== undefined) {
      filterClauses.push(`${quoteIdent(this.tsColumn)} >= ${quoteLiteral(query.start)}`);
    }
    if (query.end !== undefined) {
      filterClauses.push(`${quoteIdent(this.tsColumn)} <= ${quoteLiteral(query.end)}`);
    }
    const where = filterClauses.length === 0 ? '' : `WHERE ${filterClauses.join(' AND ')}`;
    const unions = validPrefixes
      .map(
        (prefix) =>
          `SELECT * FROM read_parquet(${quoteLiteral(this.partitionGlob(prefix))}, filename=true) ${where}`,
      )
      .join(' UNION ALL ');
    const dedup = `
      WITH all_rows AS (${unions}),
      ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY ${quoteIdent(this.codeColumn)}, ${quoteIdent(this.tsColumn)}
          ORDER BY filename DESC
        ) AS _rn FROM all_rows
      )
      SELECT ${cols} FROM ranked WHERE _rn = 1
      ORDER BY ${quoteIdent(this.codeColumn)} ASC, ${quoteIdent(this.tsColumn)} ASC
    `;
    if (query.tail !== undefined) {
      const tail = query.tail;
      return `
        WITH dedup AS (${dedup})
        SELECT ${cols} FROM (
          SELECT *, row_number() OVER (
            PARTITION BY ${quoteIdent(this.codeColumn)}
            ORDER BY ${quoteIdent(this.tsColumn)} DESC
          ) AS _trn FROM dedup
        )
        WHERE _trn <= ${tail}
        ORDER BY ${quoteIdent(this.codeColumn)} ASC, ${quoteIdent(this.tsColumn)} ASC;
      `;
    }
    return `${dedup};`;
  }

  private async compactPartition(prefix: string): Promise<void> {
    const dir = join(this.tableRoot, prefix);
    const files = await this.listPartitionFiles(prefix);
    if (files.length === 0) return;
    if (files.length === 1 && files[0] === MAIN_FILENAME) return;
    const conn = await this.connection();
    const target = join(dir, MAIN_FILENAME);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const cols = this.opts.columns.map((c) => quoteIdent(c.name)).join(', ');
    const glob = this.partitionGlob(prefix);
    const sql = `
      COPY (
        WITH ranked AS (
          SELECT *, row_number() OVER (
            PARTITION BY ${quoteIdent(this.codeColumn)}, ${quoteIdent(this.tsColumn)}
            ORDER BY filename DESC
          ) AS _rn
          FROM read_parquet(${quoteLiteral(glob)}, filename=true)
        )
        SELECT ${cols} FROM ranked WHERE _rn = 1
        ORDER BY ${quoteIdent(this.codeColumn)}, ${quoteIdent(this.tsColumn)}
      ) TO ${quoteLiteral(tmp)} (FORMAT PARQUET);
    `;
    try {
      await conn.run(sql);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    // Delete the deltas we observed before compaction. New deltas (none,
    // since we hold the write mutex) are preserved.
    for (const filename of files) {
      if (filename === MAIN_FILENAME) continue;
      await rm(join(dir, filename), { force: true });
    }
  }

  private partitionGlob(prefix: string): string {
    return join(this.tableRoot, prefix, '*.parquet');
  }

  private async partitionHasFiles(prefix: string): Promise<boolean> {
    const files = await this.listPartitionFiles(prefix);
    return files.length > 0;
  }

  private async listPartitionFiles(prefix: string): Promise<readonly string[]> {
    try {
      const dir = join(this.tableRoot, prefix);
      const entries = await readdir(dir);
      return entries.filter((e) => e.endsWith('.parquet'));
    } catch {
      return [];
    }
  }

  private async resolvePrefixes(entityKeys: readonly string[] | undefined): Promise<readonly string[]> {
    if (entityKeys === undefined) {
      return this.listExistingPrefixes();
    }
    const prefixes = new Set<string>();
    for (const key of entityKeys) prefixes.add(this.partitionKey(key));
    return Array.from(prefixes);
  }

  private async withPartitionLock<R>(prefix: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.partitionMutex.get(prefix) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.partitionMutex.set(
      prefix,
      next.catch(() => undefined),
    );
    return next;
  }

  private parseRow(
    raw: Record<string, unknown>,
    projection?: readonly (keyof Row & string)[],
  ): Row {
    const out: Record<string, unknown> = {};
    const colByName = new Map(this.opts.columns.map((c) => [c.name, c]));
    const wanted = projection ?? this.opts.columns.map((c) => c.name);
    for (const name of wanted) {
      const col = colByName.get(name);
      const v = raw[name];
      out[name] =
        col !== undefined && (col.type === 'TIMESTAMP' || col.type === 'DATE')
          ? normalizeDate(v)
          : normalizeValue(v);
    }
    return out as Row;
  }
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function quoteLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `TIMESTAMP '${v.toISOString().replace('T', ' ').replace('Z', '')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

function normalizeDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'bigint') return new Date(Number(v));
  // DuckDBTimestampValue { micros: bigint }, DuckDBDateValue { days: number }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj['micros'] === 'bigint') {
      return new Date(Number(obj['micros'] as bigint) / 1000);
    }
    if (typeof obj['days'] === 'number') {
      return new Date(obj['days'] * 86_400_000);
    }
  }
  return null;
}

function formatTimestamp(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  const ms = d.getUTCMilliseconds().toString().padStart(3, '0');
  return `${y}${m}${day}${hh}${mm}${ss}${ms}`;
}

// Useful for tests that want to inspect the partition layout without
// reaching into private methods.
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
