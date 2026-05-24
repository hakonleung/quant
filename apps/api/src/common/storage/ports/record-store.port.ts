/**
 * Row-oriented store of homogeneous records keyed by a primary key.
 *
 * Concrete implementations: `DuckDBParquetRecordStore` (prod),
 * `InMemoryRecordStore` (test fake). The two must be behaviourally
 * indistinguishable — `equivalence.spec.ts` enforces this.
 */

import type { z } from 'zod';

export type RecordKey = string | number;

export interface RecordFilter<V> {
  /** Optional equality predicates: column → expected value. */
  readonly where?: Partial<Record<keyof V & string, V[keyof V & string] | null>>;
  /** Optional in-set predicate on a single column. */
  readonly whereIn?: {
    readonly column: keyof V & string;
    readonly values: readonly (string | number)[];
  };
  /** Project a subset of columns; full row returned when omitted. */
  readonly columns?: readonly (keyof V & string)[];
  /** Sort spec: column + direction; applied in order. */
  readonly orderBy?: readonly { readonly column: keyof V & string; readonly dir: 'asc' | 'desc' }[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface RecordStore<V, K extends RecordKey = string> {
  /** Single-row read by primary key; `null` when absent. */
  get(key: K): Promise<V | null>;
  /** Batch read; missing keys are simply absent from the result. */
  getMany(keys: readonly K[]): Promise<readonly V[]>;
  /** Filtered list. With no filter, returns every row (use with care for large tables). */
  list(filter?: RecordFilter<V>): Promise<readonly V[]>;
  /** Insert-or-replace by primary key; atomic per row. */
  upsert(value: V): Promise<void>;
  /** Batch upsert; commits as one transaction. */
  upsertMany(values: readonly V[]): Promise<void>;
  /** Delete by key; returns true when a row was removed. */
  delete(key: K): Promise<boolean>;
  /** Batch delete; returns number of rows removed. */
  deleteMany(keys: readonly K[]): Promise<number>;
  /** Row count, optionally filtered. */
  count(filter?: RecordFilter<V>): Promise<number>;
  /** Flush any in-memory buffers to durable storage. No-op for some backends. */
  flush(): Promise<void>;
}

/** Schema + pk extractor describing a concrete table for a `RecordStore`. */
export interface RecordTableSpec<V, K extends RecordKey = string> {
  /** Stable table name; doubles as parquet partition directory name. */
  readonly table: string;
  /** Zod schema for runtime validation of rows read from disk. */
  readonly schema: z.ZodType<V>;
  /** Extracts the primary key from a row. */
  readonly pk: (value: V) => K;
  /** Columns to declare in the DuckDB table; required for typed parquet write. */
  readonly columns: readonly RecordColumnSpec[];
}

export interface RecordColumnSpec {
  readonly name: string;
  readonly type:
    | 'VARCHAR'
    | 'INTEGER'
    | 'BIGINT'
    | 'DOUBLE'
    | 'BOOLEAN'
    | 'TIMESTAMP'
    | 'DATE'
    | 'BLOB';
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  /**
   * Raw SQL expression to use when this column is absent from the
   * on-disk parquet (schema evolution after adding a new column to an
   * existing table). The adapter substitutes the expression into the
   * load `SELECT` list as `<defaultOnLoad> AS <name>`. Must be valid
   * DuckDB SQL and self-quoted — e.g. `"'a'"` for a string literal,
   * `'0'` for an int, `'NULL'` for a nullable column. When unset and
   * the column is missing from the parquet, the load fails (preserves
   * the strict-schema default).
   */
  readonly defaultOnLoad?: string;
}
