/**
 * `KeyValueStore` adapter backed by ioredis.
 *
 * - All values are stored as `Buffer`; callers serialise (msgpack /
 *   JSON / raw bytes — outside this adapter's concern).
 * - TTLs are passed via the `EX` option for second resolution. ioredis
 *   also supports `PX` (millisecond), but every plan-mandated use case
 *   uses ≥ 1s TTL, so we stay coarse.
 * - Errors from the upstream Redis are surfaced to the caller. The
 *   higher-level `CachedRecordStore` decorator (see neighbour file)
 *   swallows them and degrades to L2, which keeps business code from
 *   needing try/catch around every cache read.
 * - `deletePrefix` uses SCAN + DEL to avoid the O(N) blocking of `KEYS`.
 */

import type { Redis } from 'ioredis';

import type { KeyValueStore } from '../ports/key-value-store.port.js';

export interface RedisKeyValueStoreOptions {
  readonly client: Redis;
  /**
   * Optional prefix prepended to every key. Use this to namespace the
   * cache (e.g., `quant:meta:`). The trailing separator is the
   * caller's responsibility.
   */
  readonly keyPrefix?: string;
  /** SCAN batch size; default 500. */
  readonly scanCount?: number;
}

const DEFAULT_SCAN_COUNT = 500;

export class RedisKeyValueStore implements KeyValueStore {
  private readonly prefix: string;
  private readonly scanCount: number;

  constructor(private readonly opts: RedisKeyValueStoreOptions) {
    this.prefix = opts.keyPrefix ?? '';
    this.scanCount = opts.scanCount ?? DEFAULT_SCAN_COUNT;
  }

  private k(key: string): string {
    return this.prefix === '' ? key : `${this.prefix}${key}`;
  }

  async get(key: string): Promise<Buffer | null> {
    const v = await this.opts.client.getBuffer(this.k(key));
    return v ?? null;
  }

  async put(key: string, value: Buffer, ttlSec?: number): Promise<void> {
    if (ttlSec !== undefined) {
      await this.opts.client.set(this.k(key), value, 'EX', ttlSec);
    } else {
      await this.opts.client.set(this.k(key), value);
    }
  }

  async putIfAbsent(key: string, value: Buffer, ttlSec?: number): Promise<boolean> {
    const result =
      ttlSec !== undefined
        ? await this.opts.client.set(this.k(key), value, 'EX', ttlSec, 'NX')
        : await this.opts.client.set(this.k(key), value, 'NX');
    return result === 'OK';
  }

  async delete(key: string): Promise<boolean> {
    const n = await this.opts.client.del(this.k(key));
    return n > 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const match = `${this.k(prefix)}*`;
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.opts.client.scan(
        cursor,
        'MATCH',
        match,
        'COUNT',
        this.scanCount,
      );
      cursor = next;
      if (keys.length > 0) {
        removed += await this.opts.client.del(...keys);
      }
    } while (cursor !== '0');
    return removed;
  }

  async touch(key: string, ttlSec: number): Promise<boolean> {
    const n = await this.opts.client.expire(this.k(key), ttlSec);
    return n === 1;
  }
}
