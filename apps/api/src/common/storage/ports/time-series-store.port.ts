/**
 * Append-mostly store keyed by `(entityKey, ts)`. Primary user is kline,
 * but the shape applies to any per-entity time series (sentiment scores,
 * minute-bar quotes, future intraday feeds).
 *
 * Writes are batched and routed to a partition derived from `entityKey`.
 * Reads project columns + filter by `(entityKey, ts)` ranges; predicate
 * pushdown is delegated to the backend.
 */

export interface TimeSeriesReadQuery<Row> {
  /** Filter to a set of entities; `undefined` means full universe. */
  readonly entityKeys?: readonly string[];
  /** Inclusive lower bound on `ts`. */
  readonly start?: Date;
  /** Inclusive upper bound on `ts`. */
  readonly end?: Date;
  /** Project a subset of columns to reduce IO. */
  readonly columns?: readonly (keyof Row & string)[];
  /** Per-entity tail size (e.g., last N bars). Applied after time filters. */
  readonly tail?: number;
}

export interface TimeSeriesStore<Row extends { code: string; ts: Date }> {
  /** Stream-style read; returns rows already sorted by `(code, ts asc)`. */
  read(query: TimeSeriesReadQuery<Row>): Promise<readonly Row[]>;
  /**
   * Append a batch of rows. Implementation decides whether to write a
   * delta file (LSM) or rewrite the partition. Atomic — either every
   * row in the batch is visible to subsequent reads, or none is.
   */
  appendBars(rows: readonly Row[]): Promise<void>;
  /** Latest `ts` for a given entity, or `null` when no rows exist. */
  lastTimestamp(entityKey: string): Promise<Date | null>;
  /** Latest `ts` for many entities; missing entries are absent from the map. */
  lastTimestamps(entityKeys: readonly string[]): Promise<ReadonlyMap<string, Date>>;
  /** Coalesce delta files into the base partition. Safe to call concurrently with reads. */
  compact(partitionKey?: string): Promise<void>;
}
