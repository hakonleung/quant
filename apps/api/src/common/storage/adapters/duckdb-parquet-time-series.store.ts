/**
 * `TimeSeriesStore` backed by DuckDB + flat partitioned Parquet:
 *
 *   <dataRoot>/<table>/<prefix>.parquet
 *
 * - Writes group rows by partition key (default `code[:3]`) and rewrite
 *   the whole partition file on each `appendBars`. Atomicity is
 *   `tmp + rename`; per-partition mutex serialises the read-merge-write
 *   cycle so two concurrent appends to the same partition cannot lose
 *   rows.
 * - Reads use `read_parquet(['<prefix>.parquet', ...])` against the
 *   prefixes the query touches; missing files are skipped.
 * - `compact()` is a no-op kept for backward API compat — there is no
 *   delta tier to compact.
 *
 * Why not an LSM (main + deltas) layout? Daily writes are ~5500 rows
 * across ~13 partitions = ~420 rows / partition / day. A whole-partition
 * rewrite costs ~50 ms each, ~700 ms across all 13 partitions — well
 * within the cron budget — and the flat layout is dramatically simpler
 * to operate (one file per prefix on disk).
 */

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';

import type { RecordColumnSpec } from '../ports/record-store.port.js';
import type { TimeSeriesReadQuery, TimeSeriesStore } from '../ports/time-series-store.port.js';

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

export class DuckDBParquetTimeSeriesStore<
  Row extends { code: string; ts: Date },
> implements TimeSeriesStore<Row> {
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
        this.withPartitionLock(prefix, () => this.rewritePartition(prefix, group)),
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
      const file = this.partitionFile(prefix);
      if (!(await fileExists(file))) continue;
      const sql = `
        SELECT ${quoteIdent(this.codeColumn)} AS code,
               max(${quoteIdent(this.tsColumn)}) AS last_ts
        FROM read_parquet(${quoteLiteral(file)})
        WHERE ${quoteIdent(this.codeColumn)} IN (${codeList})
        GROUP BY ${quoteIdent(this.codeColumn)};
      `;
      const result = await conn.runAndReadAll(sql);
      for (const row of result.getRowObjects()) {
        const obj = row as Record<string, unknown>;
        const code = String(obj['code']);
        const ts = normalizeDate(obj['last_ts']);
        if (ts !== null) out.set(code, ts);
      }
    }
    return out;
  }

  /** No-op — kept for API symmetry with stores that have a delta tier. */
  async compact(_partitionKey?: string): Promise<void> {
    void _partitionKey;
  }

  /** Visible for tests. */
  async listExistingPrefixes(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.tableRoot);
      return entries
        .filter((name) => name.endsWith('.parquet'))
        .map((name) => name.slice(0, -'.parquet'.length));
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

  private async rewritePartition(prefix: string, newRows: readonly Row[]): Promise<void> {
    await mkdir(this.tableRoot, { recursive: true });
    const target = this.partitionFile(prefix);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const conn = await this.connection();
    const colNames = this.opts.columns.map((c) => c.name);
    const colList = colNames.map(quoteIdent).join(', ');
    const newRowsSql = newRows
      .map((row) => {
        const obj = row as unknown as Record<string, unknown>;
        return `(${colNames.map((c) => quoteLiteral(obj[c])).join(', ')})`;
      })
      .join(', ');
    const newSelect = `SELECT * FROM (VALUES ${newRowsSql}) AS t(${colList})`;
    const existingSelect = (await fileExists(target))
      ? `SELECT ${colList} FROM read_parquet(${quoteLiteral(target)})`
      : null;
    // De-dup by (code, ts) preferring the new row when both exist —
    // adjustment-factor backfills are the canonical case for an
    // overwrite on a (code, ts) the partition already has.
    const merge =
      existingSelect === null
        ? `WITH src AS (${newSelect}) SELECT ${colList} FROM src ORDER BY ${quoteIdent(this.codeColumn)}, ${quoteIdent(this.tsColumn)}`
        : `
          WITH new_rows AS (${newSelect}),
               old_rows AS (${existingSelect}),
               combined AS (
                 SELECT *, 1 AS _src FROM new_rows
                 UNION ALL
                 SELECT *, 0 AS _src FROM old_rows
               ),
               ranked AS (
                 SELECT *,
                        row_number() OVER (
                          PARTITION BY ${quoteIdent(this.codeColumn)}, ${quoteIdent(this.tsColumn)}
                          ORDER BY _src DESC
                        ) AS _rn
                 FROM combined
               )
          SELECT ${colList} FROM ranked WHERE _rn = 1
          ORDER BY ${quoteIdent(this.codeColumn)}, ${quoteIdent(this.tsColumn)}
        `;
    try {
      await conn.run(`COPY (${merge}) TO ${quoteLiteral(tmp)} (FORMAT PARQUET);`);
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
    const existing: string[] = [];
    for (const prefix of prefixes) {
      const file = this.partitionFile(prefix);
      if (await fileExists(file)) existing.push(file);
    }
    if (existing.length === 0) return null;
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
    const fileList = existing.map((p) => quoteLiteral(p)).join(', ');
    const base = `
      SELECT * FROM read_parquet([${fileList}])
      ${where}
    `;
    const ordered = `
      WITH src AS (${base})
      SELECT ${cols} FROM src
      ORDER BY ${quoteIdent(this.codeColumn)} ASC, ${quoteIdent(this.tsColumn)} ASC
    `;
    if (query.tail !== undefined) {
      const tail = query.tail;
      return `
        WITH ordered AS (${ordered})
        SELECT ${cols} FROM (
          SELECT *, row_number() OVER (
            PARTITION BY ${quoteIdent(this.codeColumn)}
            ORDER BY ${quoteIdent(this.tsColumn)} DESC
          ) AS _trn FROM ordered
        )
        WHERE _trn <= ${tail}
        ORDER BY ${quoteIdent(this.codeColumn)} ASC, ${quoteIdent(this.tsColumn)} ASC;
      `;
    }
    return `${ordered};`;
  }

  private partitionFile(prefix: string): string {
    return join(this.tableRoot, `${prefix}.parquet`);
  }

  private async resolvePrefixes(
    entityKeys: readonly string[] | undefined,
  ): Promise<readonly string[]> {
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

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
