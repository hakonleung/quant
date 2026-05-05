import { beforeEach, describe, expect, it } from 'vitest';
import { MockCache } from '../actions/mock-cache.js';

describe('MockCache', () => {
  let cache: MockCache;
  beforeEach(() => {
    cache = new MockCache(null);
  });

  it('returns undefined on miss (golden)', () => {
    expect(cache.get(['a', 1])).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it('returns set value on hit', () => {
    cache.set(['a', 1], { x: 42 });
    expect(cache.get(['a', 1])).toEqual({ x: 42 });
    expect(cache.stats().hits).toBe(1);
  });

  it('TTL expires entries', async () => {
    const c = new MockCache(null, 5);
    c.set(['k'], 'v');
    await new Promise((r) => setTimeout(r, 20));
    expect(c.get(['k'])).toBeUndefined();
  });

  it('invalidate removes by exact key', () => {
    cache.set(['a', 1], 1);
    cache.set(['a', 2], 2);
    expect(cache.invalidate(['a', 1])).toBe(1);
    expect(cache.get(['a', 1])).toBeUndefined();
    expect(cache.get(['a', 2])).toBe(2);
  });

  it('invalidate removes by prefix', () => {
    cache.set(['stock.info', '600519'], 1);
    cache.set(['stock.info', '000001'], 2);
    cache.set(['stock.list'], 3);
    expect(cache.invalidate(['stock.info'])).toBe(2);
    expect(cache.get(['stock.info', '600519'])).toBeUndefined();
    expect(cache.get(['stock.list'])).toBe(3);
  });

  it('clear empties cache', () => {
    cache.set(['a'], 1);
    cache.clear();
    expect(cache.stats().entries).toBe(0);
  });
});
