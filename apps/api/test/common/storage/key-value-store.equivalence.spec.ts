/**
 * Equivalence spec between `InMemoryKeyValueStore` and
 * `RedisKeyValueStore`.
 *
 * The Redis case is opt-in: set `TEST_REDIS_URL` to point at a running
 * instance (e.g., `redis://127.0.0.1:6379/15`). CI without Redis just
 * runs the in-memory tier. The two backends must behave identically
 * across get/put/putIfAbsent/delete/deletePrefix/touch + TTL semantics.
 */

import { Redis } from 'ioredis';

import type { KeyValueStore } from '../../../src/common/storage/ports/key-value-store.port.js';
import { RedisKeyValueStore } from '../../../src/common/storage/adapters/redis-kv.store.js';
import { InMemoryKeyValueStore } from '../../fakes/in-memory-key-value.store.js';

interface Backend {
  readonly label: string;
  build: () => Promise<KeyValueStore>;
  cleanup: () => Promise<void>;
}

function inMemoryBackend(): Backend {
  let now = Date.now();
  return {
    label: 'in-memory',
    async build() {
      now = Date.now();
      return new InMemoryKeyValueStore(() => now);
    },
    async cleanup() {
      // nothing
    },
  };
}

function redisBackend(url: string): Backend {
  let client: Redis | null = null;
  let store: RedisKeyValueStore | null = null;
  const prefix = `test:${Math.random().toString(36).slice(2)}:`;
  return {
    label: 'redis',
    async build() {
      const next = new Redis(url);
      client = next;
      store = new RedisKeyValueStore({ client: next, keyPrefix: prefix });
      return store;
    },
    async cleanup() {
      const current = client;
      const storeRef = store;
      if (current !== null && storeRef !== null) {
        await storeRef.deletePrefix('');
        await current.quit();
      }
      store = null;
      client = null;
    },
  };
}

const redisUrl = process.env['TEST_REDIS_URL'];
const backends: Backend[] = [inMemoryBackend()];
if (redisUrl !== undefined && redisUrl !== '') {
  backends.push(redisBackend(redisUrl));
}

describe.each(backends)('KeyValueStore [$label]', (backend) => {
  let store: KeyValueStore;

  beforeEach(async () => {
    store = await backend.build();
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  it('returns null for missing key', async () => {
    await expect(store.get('missing')).resolves.toBeNull();
  });

  it('put then get round-trips the buffer', async () => {
    await store.put('k', Buffer.from('hello'));
    const v = await store.get('k');
    expect(v?.toString('utf8')).toBe('hello');
  });

  it('put overwrites existing value', async () => {
    await store.put('k', Buffer.from('one'));
    await store.put('k', Buffer.from('two'));
    expect((await store.get('k'))?.toString('utf8')).toBe('two');
  });

  it('putIfAbsent sets only when absent', async () => {
    await expect(store.putIfAbsent('k', Buffer.from('first'))).resolves.toBe(true);
    await expect(store.putIfAbsent('k', Buffer.from('second'))).resolves.toBe(false);
    expect((await store.get('k'))?.toString('utf8')).toBe('first');
  });

  it('delete returns true on existing key, false on missing', async () => {
    await store.put('k', Buffer.from('x'));
    await expect(store.delete('k')).resolves.toBe(true);
    await expect(store.delete('k')).resolves.toBe(false);
  });

  it('deletePrefix removes only matching keys', async () => {
    await store.put('a:1', Buffer.from('1'));
    await store.put('a:2', Buffer.from('2'));
    await store.put('b:1', Buffer.from('3'));
    await expect(store.deletePrefix('a:')).resolves.toBe(2);
    expect(await store.get('a:1')).toBeNull();
    expect(await store.get('a:2')).toBeNull();
    expect((await store.get('b:1'))?.toString('utf8')).toBe('3');
  });

  it('touch updates TTL on existing key', async () => {
    await store.put('k', Buffer.from('v'), 60);
    await expect(store.touch('k', 120)).resolves.toBe(true);
    await expect(store.touch('missing', 120)).resolves.toBe(false);
  });
});

describe('InMemoryKeyValueStore TTL behaviour', () => {
  it('returns null after TTL elapses (uses injected clock)', async () => {
    let now = 1_000_000;
    const store = new InMemoryKeyValueStore(() => now);
    await store.put('k', Buffer.from('v'), 30);
    expect((await store.get('k'))?.toString('utf8')).toBe('v');
    now += 31_000;
    await expect(store.get('k')).resolves.toBeNull();
  });

  it('putIfAbsent succeeds after the previous entry expires', async () => {
    let now = 1_000_000;
    const store = new InMemoryKeyValueStore(() => now);
    await store.put('k', Buffer.from('old'), 10);
    now += 20_000;
    await expect(store.putIfAbsent('k', Buffer.from('new'), 60)).resolves.toBe(true);
    expect((await store.get('k'))?.toString('utf8')).toBe('new');
  });
});
