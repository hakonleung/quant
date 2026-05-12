/**
 * Redis cache wiring for the storage layer.
 *
 * Exposes:
 *   - `REDIS_CACHE_CLIENT`     — ioredis Redis singleton (lazy connect).
 *   - `REDIS_CACHE_KV_STORE`   — `KeyValueStore` adapter on the client.
 *   - `REDIS_INVALIDATION_BUS` — small pub/sub helper for cross-process
 *     cache invalidation (plan §2.3).
 *
 * Env:
 *   - `CACHE_REDIS_URL` (default `redis://127.0.0.1:6379/1`) — db 1 so
 *     we don't collide with BullMQ on db 0.
 *   - `CACHE_REDIS_KEY_PREFIX` (default `quant:cache:`) — applied to
 *     every KV write via `RedisKeyValueStore.keyPrefix`. Invalidation
 *     channel names are NOT prefixed (Redis pub/sub is a separate
 *     namespace).
 *
 * If Redis is unreachable, the client will surface connection errors
 * through ioredis events — callers go through `CachedRecordStore` which
 * degrades to L2. Production deployments without Redis should opt out
 * of caching at the module level rather than wiring this module.
 */

import { Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { RedisKeyValueStore } from './adapters/redis-kv.store.js';
import type { KeyValueStore } from './ports/key-value-store.port.js';

export const REDIS_CACHE_CLIENT = Symbol('REDIS_CACHE_CLIENT');
export const REDIS_CACHE_KV_STORE = Symbol('REDIS_CACHE_KV_STORE');
export const REDIS_INVALIDATION_BUS = Symbol('REDIS_INVALIDATION_BUS');

export interface InvalidationBus {
  /** Publish a topic + key list to subscribers. */
  publish(topic: string, keys: readonly string[]): Promise<void>;
  /** Subscribe; returns an unsubscribe handle. */
  subscribe(topic: string, fn: (keys: readonly string[]) => void): Promise<() => Promise<void>>;
}

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379/1';
const DEFAULT_KEY_PREFIX = 'quant:cache:';
const INVALIDATION_CHANNEL_PREFIX = 'quant:invalidate:';

class RedisInvalidationBus implements InvalidationBus, OnModuleDestroy {
  private readonly logger = new Logger(RedisInvalidationBus.name);
  private readonly subscribers = new Map<string, Set<(keys: readonly string[]) => void>>();
  private subClient: Redis | null = null;

  constructor(private readonly pubClient: Redis, private readonly url: string) {}

  async publish(topic: string, keys: readonly string[]): Promise<void> {
    const payload = JSON.stringify({ topic, keys, ts: Date.now() });
    await this.pubClient.publish(`${INVALIDATION_CHANNEL_PREFIX}${topic}`, payload);
  }

  async subscribe(
    topic: string,
    fn: (keys: readonly string[]) => void,
  ): Promise<() => Promise<void>> {
    const channel = `${INVALIDATION_CHANNEL_PREFIX}${topic}`;
    let set = this.subscribers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(channel, set);
      await this.ensureSubClient();
      await this.subClient!.subscribe(channel);
    }
    set.add(fn);
    return async () => {
      const current = this.subscribers.get(channel);
      if (current === undefined) return;
      current.delete(fn);
      if (current.size === 0) {
        this.subscribers.delete(channel);
        try {
          await this.subClient?.unsubscribe(channel);
        } catch (err) {
          this.logger.warn(`unsubscribe ${channel} failed: ${String(err)}`);
        }
      }
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subClient !== null) {
      try {
        await this.subClient.quit();
      } catch (err) {
        this.logger.warn(`subscriber quit failed: ${String(err)}`);
      }
      this.subClient = null;
    }
  }

  private async ensureSubClient(): Promise<void> {
    if (this.subClient !== null) return;
    this.subClient = new Redis(this.url);
    this.subClient.on('message', (channel: string, message: string) => {
      try {
        const decoded = JSON.parse(message) as { keys?: readonly string[] };
        const subs = this.subscribers.get(channel);
        if (subs === undefined) return;
        const keys = decoded.keys ?? [];
        for (const fn of subs) {
          try {
            fn(keys);
          } catch (err) {
            this.logger.warn(`invalidation handler threw for ${channel}: ${String(err)}`);
          }
        }
      } catch (err) {
        this.logger.warn(`malformed invalidation payload on ${channel}: ${String(err)}`);
      }
    });
  }
}

class RedisLifecycle implements OnModuleDestroy {
  constructor(private readonly client: Redis, private readonly bus: RedisInvalidationBus) {}
  async onModuleDestroy(): Promise<void> {
    await this.bus.onModuleDestroy();
    try {
      await this.client.quit();
    } catch {
      // ignore
    }
  }
}

@Module({
  providers: [
    {
      provide: REDIS_CACHE_CLIENT,
      useFactory: (): Redis => {
        const url = process.env['CACHE_REDIS_URL'] ?? DEFAULT_REDIS_URL;
        return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      },
    },
    {
      provide: REDIS_CACHE_KV_STORE,
      inject: [REDIS_CACHE_CLIENT],
      useFactory: (client: Redis): KeyValueStore =>
        new RedisKeyValueStore({
          client,
          keyPrefix: process.env['CACHE_REDIS_KEY_PREFIX'] ?? DEFAULT_KEY_PREFIX,
        }),
    },
    {
      provide: REDIS_INVALIDATION_BUS,
      inject: [REDIS_CACHE_CLIENT],
      useFactory: (client: Redis): InvalidationBus => {
        const url = process.env['CACHE_REDIS_URL'] ?? DEFAULT_REDIS_URL;
        return new RedisInvalidationBus(client, url);
      },
    },
    {
      provide: RedisLifecycle,
      inject: [REDIS_CACHE_CLIENT, REDIS_INVALIDATION_BUS],
      useFactory: (client: Redis, bus: InvalidationBus): RedisLifecycle =>
        new RedisLifecycle(client, bus as RedisInvalidationBus),
    },
  ],
  exports: [REDIS_CACHE_CLIENT, REDIS_CACHE_KV_STORE, REDIS_INVALIDATION_BUS],
})
export class RedisCacheModule {}
