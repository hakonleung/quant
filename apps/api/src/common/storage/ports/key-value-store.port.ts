/**
 * Short-TTL key-value store. Production adapter is Redis; in-memory
 * fake mirrors the same TTL semantics for tests.
 *
 * Values are stored as binary buffers — callers serialise. This keeps
 * the port narrow and avoids each module re-implementing
 * "JSON or msgpack?" decisions inside the storage layer.
 */

export interface KeyValueStore {
  /** Returns the raw stored buffer, or `null` when absent or expired. */
  get(key: string): Promise<Buffer | null>;
  /**
   * Set `key` to `value` with optional TTL in seconds. `ttlSec === undefined`
   * means no expiry. Overwrites any existing value.
   */
  put(key: string, value: Buffer, ttlSec?: number): Promise<void>;
  /** Atomic set-if-absent. Returns true when the key was newly set. */
  putIfAbsent(key: string, value: Buffer, ttlSec?: number): Promise<boolean>;
  /** Remove a key; returns true when a key was removed. */
  delete(key: string): Promise<boolean>;
  /** Returns the number of keys removed. Glob patterns optional and backend-specific. */
  deletePrefix(prefix: string): Promise<number>;
  /** Heartbeat the TTL without changing the value; returns true when the key exists. */
  touch(key: string, ttlSec: number): Promise<boolean>;
}
