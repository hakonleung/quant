/**
 * Per-user view over a `RecordStore`. All operations are scoped to a
 * single `userId`; the underlying storage may partition by user (parquet
 * partition / table prefix / row column) — callers don't care.
 *
 * Replaces `UserScopedJsonStore<T>`'s blob-per-user model with row-level
 * CRUD. Module facades (`LedgerStore`, `WatchTaskStore`, ...) wrap one
 * of these and preserve their public methods.
 */

import type { RecordFilter, RecordKey } from './record-store.port.js';

export interface UserScopedRecordStore<V, K extends RecordKey = string> {
  get(userId: string, key: K): Promise<V | null>;
  getMany(userId: string, keys: readonly K[]): Promise<readonly V[]>;
  list(userId: string, filter?: RecordFilter<V>): Promise<readonly V[]>;
  upsert(userId: string, value: V): Promise<void>;
  upsertMany(userId: string, values: readonly V[]): Promise<void>;
  delete(userId: string, key: K): Promise<boolean>;
  deleteMany(userId: string, keys: readonly K[]): Promise<number>;
  count(userId: string, filter?: RecordFilter<V>): Promise<number>;
  /** Wipe all rows for a user. Used when a user is deleted. */
  purge(userId: string): Promise<void>;
  flush(userId?: string): Promise<void>;
}
