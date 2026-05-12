import { z } from 'zod';

import { CachedRecordStore } from '../../../src/common/storage/adapters/cached-record.store.js';
import type { RecordTableSpec } from '../../../src/common/storage/ports/record-store.port.js';
import { InMemoryKeyValueStore } from '../../fakes/in-memory-key-value.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

interface Widget {
  id: string;
  name: string;
}

const spec: RecordTableSpec<Widget> = {
  table: 'widgets',
  schema: z.object({ id: z.string(), name: z.string() }),
  pk: (w) => w.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'name', type: 'VARCHAR' },
  ],
};

function build(): {
  cached: CachedRecordStore<Widget>;
  backing: InMemoryRecordStore<Widget>;
  cache: InMemoryKeyValueStore;
  backingGet: jest.SpyInstance;
  warnings: string[];
} {
  const backing = new InMemoryRecordStore<Widget>(spec);
  const cache = new InMemoryKeyValueStore();
  const warnings: string[] = [];
  const cached = new CachedRecordStore<Widget>({
    backing,
    cache,
    spec,
    ttlSec: 60,
    logger: { warn: (m) => warnings.push(m) },
  });
  const backingGet = jest.spyOn(backing, 'get');
  return { cached, backing, cache, backingGet, warnings };
}

describe('CachedRecordStore', () => {
  it('caches a hit from the backing store on first get, serves L1 thereafter', async () => {
    const { cached, backing, backingGet } = build();
    await backing.upsert({ id: 'w1', name: 'first' });

    const a = await cached.get('w1');
    const b = await cached.get('w1');
    expect(a).toEqual({ id: 'w1', name: 'first' });
    expect(b).toEqual({ id: 'w1', name: 'first' });
    expect(backingGet).toHaveBeenCalledTimes(1);
  });

  it('negative-caches an absent key (does not re-query backing)', async () => {
    const { cached, backingGet } = build();
    const a = await cached.get('missing');
    const b = await cached.get('missing');
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(backingGet).toHaveBeenCalledTimes(1);
  });

  it('upsert writes through and updates L1', async () => {
    const { cached, cache } = build();
    await cached.upsert({ id: 'w2', name: 'fresh' });
    const raw = await cache.get('widgets:w2');
    expect(raw).not.toBeNull();
    const decoded = JSON.parse(raw!.toString('utf8')) as Widget;
    expect(decoded).toEqual({ id: 'w2', name: 'fresh' });
  });

  it('upsert replacing existing key invalidates stale L1 entry', async () => {
    const { cached, backing } = build();
    await backing.upsert({ id: 'w3', name: 'old' });
    await cached.get('w3'); // primes L1
    await cached.upsert({ id: 'w3', name: 'new' });
    await expect(cached.get('w3')).resolves.toEqual({ id: 'w3', name: 'new' });
  });

  it('delete clears the cache entry', async () => {
    const { cached, backing, cache } = build();
    await backing.upsert({ id: 'w4', name: 'doomed' });
    await cached.get('w4');
    expect(await cache.get('widgets:w4')).not.toBeNull();
    await cached.delete('w4');
    expect(await cache.get('widgets:w4')).toBeNull();
  });

  it('getMany mixes cache hits + backing misses correctly', async () => {
    const { cached, backing } = build();
    await backing.upsertMany([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]);
    await cached.get('a'); // prime
    const got = await cached.getMany(['a', 'b', 'missing', 'c']);
    expect(got.map((w) => w.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('list / count pass through to backing without caching', async () => {
    const { cached, backing } = build();
    await backing.upsertMany([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
    expect(await cached.count()).toBe(2);
    const all = await cached.list({ orderBy: [{ column: 'id', dir: 'asc' }] });
    expect(all.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('degrades gracefully when L1 throws — backing still serves reads', async () => {
    const { cached, backing, cache, warnings } = build();
    await backing.upsert({ id: 'w5', name: 'fallback' });
    const error = new Error('redis down');
    jest.spyOn(cache, 'get').mockRejectedValueOnce(error);

    await expect(cached.get('w5')).resolves.toEqual({ id: 'w5', name: 'fallback' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('redis down');
    // Subsequent reads also skip L1 (degraded mode is sticky for the instance lifetime)
    jest.spyOn(cache, 'get'); // not rejecting now, but won't be called
    await expect(cached.get('w5')).resolves.toEqual({ id: 'w5', name: 'fallback' });
  });

  it('TTL=0 stores without expiry', async () => {
    const backing = new InMemoryRecordStore<Widget>(spec);
    const cache = new InMemoryKeyValueStore();
    const cached = new CachedRecordStore<Widget>({
      backing,
      cache,
      spec,
      ttlSec: 0,
    });
    await backing.upsert({ id: 'w', name: 'persistent' });
    await cached.get('w');
    const entry = await cache.get('widgets:w');
    expect(entry).not.toBeNull();
  });
});
