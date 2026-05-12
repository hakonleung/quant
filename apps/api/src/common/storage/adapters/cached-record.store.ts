/**
 * L1/L2 cache decorator over a `RecordStore`.
 *
 * - **Reads** (`get`, `getMany`): try L1 (Redis or any KV); on miss
 *   delegate to L2 and backfill L1 with the configured TTL.
 * - **Writes** (`upsert`, `upsertMany`, `delete`, `deleteMany`): commit
 *   to L2 first, then write-through (or invalidate) L1. We never
 *   short-circuit L2 — durable storage is the truth, the cache is just
 *   an accelerator.
 * - **Range ops** (`list`, `count`, `flush`): pure pass-through. We
 *   could cache them keyed by a hash of the filter, but invalidation
 *   under arbitrary `where` predicates is the kind of cleverness that
 *   silently rots; skip until proven worthwhile by a benchmark.
 * - **Failure mode**: any L1 error is logged once and treated as a miss
 *   (read) or skipped (write). The store keeps working at L2 latency.
 *   This is exactly the degradation contract `docs/perf/kline-lsm-write.md`
 *   relies on.
 */

import type {
  RecordFilter,
  RecordKey,
  RecordStore,
  RecordTableSpec,
} from '../ports/record-store.port.js';
import type { KeyValueStore } from '../ports/key-value-store.port.js';

export interface CachedRecordStoreOptions<V, K extends RecordKey = string> {
  readonly backing: RecordStore<V, K>;
  readonly cache: KeyValueStore;
  readonly spec: Pick<RecordTableSpec<V, K>, 'table' | 'pk'>;
  /** Cache TTL (seconds). Default 300. `0` disables expiry. */
  readonly ttlSec?: number;
  /** Encode a row to bytes; default = JSON.stringify. */
  readonly encode?: (value: V) => Buffer;
  /** Decode bytes to a row; default = JSON.parse. */
  readonly decode?: (raw: Buffer) => V;
  /** Optional logger; defaults to a noop. */
  readonly logger?: { warn: (msg: string) => void };
}

const DEFAULT_TTL_SEC = 300;
const NEGATIVE_MARKER = Buffer.from([0x00]); // single byte, distinguishable from any JSON

export class CachedRecordStore<V, K extends RecordKey = string> implements RecordStore<V, K> {
  private readonly ttlSec: number;
  private readonly encode: (value: V) => Buffer;
  private readonly decode: (raw: Buffer) => V;
  private readonly logger: { warn: (msg: string) => void };
  private l1Broken = false;

  constructor(private readonly opts: CachedRecordStoreOptions<V, K>) {
    this.ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
    this.encode = opts.encode ?? ((v: V): Buffer => Buffer.from(JSON.stringify(v), 'utf8'));
    this.decode = opts.decode ?? ((b: Buffer): V => JSON.parse(b.toString('utf8')) as V);
    this.logger = opts.logger ?? { warn: () => undefined };
  }

  private cacheKey(key: K): string {
    return `${this.opts.spec.table}:${String(key)}`;
  }

  async get(key: K): Promise<V | null> {
    const ck = this.cacheKey(key);
    const cached = await this.l1Read(ck);
    if (cached !== undefined) return cached;
    const fresh = await this.opts.backing.get(key);
    await this.l1Write(ck, fresh);
    return fresh;
  }

  async getMany(keys: readonly K[]): Promise<readonly V[]> {
    if (keys.length === 0) return [];
    const out: V[] = [];
    const misses: K[] = [];
    for (const key of keys) {
      const ck = this.cacheKey(key);
      const cached = await this.l1Read(ck);
      if (cached === undefined) {
        misses.push(key);
        continue;
      }
      if (cached !== null) out.push(cached);
    }
    if (misses.length > 0) {
      const rows = await this.opts.backing.getMany(misses);
      const byKey = new Map<K, V>();
      for (const row of rows) byKey.set(this.opts.spec.pk(row), row);
      for (const k of misses) {
        const v = byKey.get(k) ?? null;
        await this.l1Write(this.cacheKey(k), v);
        if (v !== null) out.push(v);
      }
    }
    return out;
  }

  async list(filter?: RecordFilter<V>): Promise<readonly V[]> {
    return this.opts.backing.list(filter);
  }

  async upsert(value: V): Promise<void> {
    await this.opts.backing.upsert(value);
    await this.l1Write(this.cacheKey(this.opts.spec.pk(value)), value);
  }

  async upsertMany(values: readonly V[]): Promise<void> {
    if (values.length === 0) return;
    await this.opts.backing.upsertMany(values);
    for (const v of values) {
      await this.l1Write(this.cacheKey(this.opts.spec.pk(v)), v);
    }
  }

  async delete(key: K): Promise<boolean> {
    const removed = await this.opts.backing.delete(key);
    await this.l1Invalidate(this.cacheKey(key));
    return removed;
  }

  async deleteMany(keys: readonly K[]): Promise<number> {
    if (keys.length === 0) return 0;
    const removed = await this.opts.backing.deleteMany(keys);
    for (const k of keys) await this.l1Invalidate(this.cacheKey(k));
    return removed;
  }

  async count(filter?: RecordFilter<V>): Promise<number> {
    return this.opts.backing.count(filter);
  }

  async flush(): Promise<void> {
    return this.opts.backing.flush();
  }

  private async l1Read(key: string): Promise<V | null | undefined> {
    if (this.l1Broken) return undefined;
    try {
      const raw = await this.opts.cache.get(key);
      if (raw === null) return undefined; // miss
      if (raw.length === 1 && raw[0] === 0x00) return null; // negative cache
      return this.decode(raw);
    } catch (err) {
      this.markBroken(err);
      return undefined;
    }
  }

  private async l1Write(key: string, value: V | null): Promise<void> {
    if (this.l1Broken) return;
    try {
      const buf = value === null ? NEGATIVE_MARKER : this.encode(value);
      const ttl = this.ttlSec === 0 ? undefined : this.ttlSec;
      await this.opts.cache.put(key, buf, ttl);
    } catch (err) {
      this.markBroken(err);
    }
  }

  private async l1Invalidate(key: string): Promise<void> {
    if (this.l1Broken) return;
    try {
      await this.opts.cache.delete(key);
    } catch (err) {
      this.markBroken(err);
    }
  }

  private markBroken(err: unknown): void {
    if (!this.l1Broken) {
      this.l1Broken = true;
      this.logger.warn(
        `CachedRecordStore L1 degraded for table ${this.opts.spec.table}: ${String(err)}`,
      );
    }
  }
}
