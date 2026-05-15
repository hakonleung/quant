/**
 * `RecordStore` backed by a single Parquet file managed via DuckDB.
 *
 * On startup, the parquet file (if present) is loaded into an in-memory
 * DuckDB table; mutations go to that table; `flush()` (or auto-flush after
 * `minFlushIntervalMs`) writes the whole table back to parquet via
 * `COPY ... TO 'tmp' (FORMAT PARQUET)` + atomic rename.
 *
 * This adapter is appropriate for tables in the 10⁴–10⁵ row range
 * (sectors / blacklist / ta cache / sentiment cache / per-user records).
 * For larger tables prefer `DuckDBParquetTimeSeriesStore`.
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';

import type {
  RecordFilter,
  RecordKey,
  RecordStore,
  RecordTableSpec,
} from '../ports/record-store.port.js';

export interface DuckDBParquetRecordStoreOptions<V, K extends RecordKey> {
  readonly dataRoot: string;
  readonly spec: RecordTableSpec<V, K>;
  /** Minimum interval between background flushes (ms). Default 1000. */
  readonly minFlushIntervalMs?: number;
}

let tmpCounter = 0;

export class DuckDBParquetRecordStore<V, K extends RecordKey = string> implements RecordStore<
  V,
  K
> {
  private connPromise: Promise<DuckDBConnection> | null = null;
  private loaded = false;
  private dirty = false;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly pkColumn: string;

  constructor(private readonly opts: DuckDBParquetRecordStoreOptions<V, K>) {
    void opts.minFlushIntervalMs; // reserved for BackgroundFlusher wrapper
    this.filePath = join(opts.dataRoot, `${opts.spec.table}.parquet`);
    const pkCol = opts.spec.columns.find((c) => c.primaryKey === true);
    if (pkCol === undefined) {
      throw new Error(`RecordTableSpec ${opts.spec.table} has no primaryKey column`);
    }
    this.pkColumn = pkCol.name;
  }

  private connection(): Promise<DuckDBConnection> {
    if (this.connPromise === null) {
      this.connPromise = (async () => {
        const inst = await DuckDBInstance.create(':memory:');
        const conn = await inst.connect();
        await conn.run(this.createTableSql());
        return conn;
      })();
    }
    return this.connPromise;
  }

  private createTableSql(): string {
    const cols = this.opts.spec.columns
      .map((c) => `${quoteIdent(c.name)} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}`)
      .join(', ');
    return `CREATE TABLE ${quoteIdent(this.opts.spec.table)} (${cols}, PRIMARY KEY (${quoteIdent(this.pkColumn)}));`;
  }

  private async ensureLoaded(): Promise<DuckDBConnection> {
    const conn = await this.connection();
    if (this.loaded) return conn;
    const exists = await fileExists(this.filePath);
    if (exists) {
      await conn.run(
        `INSERT INTO ${quoteIdent(this.opts.spec.table)} SELECT * FROM read_parquet(${quoteLiteral(this.filePath)});`,
      );
    }
    this.loaded = true;
    return conn;
  }

  async get(key: K): Promise<V | null> {
    const conn = await this.ensureLoaded();
    const sql = `SELECT * FROM ${quoteIdent(this.opts.spec.table)} WHERE ${quoteIdent(this.pkColumn)} = ${quoteLiteral(key)} LIMIT 1;`;
    const result = await conn.runAndReadAll(sql);
    const rows = result.getRowObjects();
    if (rows.length === 0) return null;
    return this.parseRow(rows[0] as Record<string, unknown>);
  }

  async getMany(keys: readonly K[]): Promise<readonly V[]> {
    if (keys.length === 0) return [];
    const conn = await this.ensureLoaded();
    const inList = keys.map((k) => quoteLiteral(k)).join(', ');
    const sql = `SELECT * FROM ${quoteIdent(this.opts.spec.table)} WHERE ${quoteIdent(this.pkColumn)} IN (${inList});`;
    const result = await conn.runAndReadAll(sql);
    return result.getRowObjects().map((r) => this.parseRow(r as Record<string, unknown>));
  }

  async list(filter?: RecordFilter<V>): Promise<readonly V[]> {
    const conn = await this.ensureLoaded();
    const sql = this.buildSelectSql(filter);
    const result = await conn.runAndReadAll(sql);
    return result
      .getRowObjects()
      .map((r) => this.parseRow(r as Record<string, unknown>, filter?.columns));
  }

  async upsert(value: V): Promise<void> {
    return this.upsertMany([value]);
  }

  async upsertMany(values: readonly V[]): Promise<void> {
    if (values.length === 0) return;
    const conn = await this.ensureLoaded();
    const colNames = this.opts.spec.columns.map((c) => c.name);
    const colList = colNames.map((c) => quoteIdent(c)).join(', ');
    const rowsSql = values
      .map((v) => {
        const obj = v as unknown as Record<string, unknown>;
        return `(${colNames.map((c) => quoteLiteral(obj[c])).join(', ')})`;
      })
      .join(', ');
    const sql = `INSERT OR REPLACE INTO ${quoteIdent(this.opts.spec.table)} (${colList}) VALUES ${rowsSql};`;
    await conn.run(sql);
    this.markDirty();
  }

  async delete(key: K): Promise<boolean> {
    const conn = await this.ensureLoaded();
    const before = await this.count();
    await conn.run(
      `DELETE FROM ${quoteIdent(this.opts.spec.table)} WHERE ${quoteIdent(this.pkColumn)} = ${quoteLiteral(key)};`,
    );
    const after = await this.count();
    if (after < before) {
      this.markDirty();
      return true;
    }
    return false;
  }

  async deleteMany(keys: readonly K[]): Promise<number> {
    if (keys.length === 0) return 0;
    const conn = await this.ensureLoaded();
    const before = await this.count();
    const inList = keys.map((k) => quoteLiteral(k)).join(', ');
    await conn.run(
      `DELETE FROM ${quoteIdent(this.opts.spec.table)} WHERE ${quoteIdent(this.pkColumn)} IN (${inList});`,
    );
    const after = await this.count();
    const removed = before - after;
    if (removed > 0) this.markDirty();
    return removed;
  }

  async count(filter?: RecordFilter<V>): Promise<number> {
    const conn = await this.ensureLoaded();
    const where = this.buildWhere(filter);
    const sql = `SELECT count(*) AS n FROM ${quoteIdent(this.opts.spec.table)}${where};`;
    const result = await conn.runAndReadAll(sql);
    const rows = result.getRowObjects();
    if (rows.length === 0) return 0;
    return Number((rows[0] as Record<string, unknown>)['n']);
  }

  async flush(): Promise<void> {
    this.flushChain = this.flushChain.then(
      () => this.runFlush(),
      () => this.runFlush(),
    );
    await this.flushChain;
  }

  private markDirty(): void {
    this.dirty = true;
    // No auto-fire here: explicit flush() is the only path to disk.
    // A background flusher can wrap this store if throttled persistence
    // is wanted; that policy doesn't belong inside the adapter.
  }

  private async runFlush(): Promise<void> {
    if (!this.dirty) return;
    // Capture-then-clear: if a write lands during COPY, we'll see the
    // re-set dirty bit and the next flush() call picks it up.
    this.dirty = false;
    const conn = await this.connection();
    await mkdir(dirname(this.filePath), { recursive: true });
    tmpCounter += 1;
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`;
    try {
      await conn.run(
        `COPY (SELECT * FROM ${quoteIdent(this.opts.spec.table)}) TO ${quoteLiteral(tmp)} (FORMAT PARQUET);`,
      );
      await rename(tmp, this.filePath);
    } catch (err) {
      this.dirty = true;
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private buildSelectSql(filter?: RecordFilter<V>): string {
    const cols =
      filter?.columns !== undefined
        ? filter.columns.map((c) => quoteIdent(c as string)).join(', ')
        : '*';
    const where = this.buildWhere(filter);
    const orderBy =
      filter?.orderBy !== undefined && filter.orderBy.length > 0
        ? ` ORDER BY ${filter.orderBy.map((o) => `${quoteIdent(o.column as string)} ${o.dir.toUpperCase()}`).join(', ')}`
        : '';
    const limit = filter?.limit !== undefined ? ` LIMIT ${filter.limit}` : '';
    const offset = filter?.offset !== undefined ? ` OFFSET ${filter.offset}` : '';
    return `SELECT ${cols} FROM ${quoteIdent(this.opts.spec.table)}${where}${orderBy}${limit}${offset};`;
  }

  private buildWhere(filter?: RecordFilter<V>): string {
    const clauses: string[] = [];
    if (filter?.where !== undefined) {
      for (const [col, expected] of Object.entries(filter.where)) {
        if (expected === null) {
          clauses.push(`${quoteIdent(col)} IS NULL`);
        } else {
          clauses.push(`${quoteIdent(col)} = ${quoteLiteral(expected)}`);
        }
      }
    }
    if (filter?.whereIn !== undefined) {
      const { column, values } = filter.whereIn;
      if (values.length === 0) {
        clauses.push('1 = 0');
      } else {
        const inList = values.map((v) => quoteLiteral(v)).join(', ');
        clauses.push(`${quoteIdent(column as string)} IN (${inList})`);
      }
    }
    return clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  }

  private parseRow(raw: Record<string, unknown>, columns?: readonly (keyof V & string)[]): V {
    // DuckDB returns Date as JS Date for TIMESTAMP/DATE; BLOB as Uint8Array.
    // Pass through; let the table spec's schema do real validation if callers want it.
    const projected: Record<string, unknown> = {};
    const cols = columns ?? this.opts.spec.columns.map((c) => c.name);
    for (const c of cols) projected[c] = normalizeValue(raw[c]);
    return projected as V;
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
  if (v instanceof Uint8Array) {
    let hex = '';
    for (const b of v) hex += b.toString(16).padStart(2, '0');
    return `'\\x${hex}'::BLOB`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    if (typeof obj['micros'] === 'bigint') {
      return new Date(Number(obj['micros'] as bigint) / 1000);
    }
    if (typeof obj['days'] === 'number') {
      return new Date(obj['days'] * 86_400_000);
    }
  }
  return v;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
