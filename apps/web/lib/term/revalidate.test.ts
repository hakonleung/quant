/**
 * `createRevalidate` — verify each scope hits the right react-query
 * keys. The sectors path is exercised separately because it touches
 * the zustand store, not react-query.
 */

import { describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { createRevalidate } from './revalidate.js';

function fakeClient(): {
  client: QueryClient;
  invalidated: ReadonlyArray<readonly unknown[]>;
} {
  const calls: (readonly unknown[])[] = [];
  const client = {
    invalidateQueries: vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
      calls.push(queryKey);
      return Promise.resolve();
    }),
  } as unknown as QueryClient;
  return { client, invalidated: calls };
}

describe('createRevalidate', () => {
  it('"meta" invalidates stock-list / stock-meta / watch-universe only', () => {
    const { client, invalidated } = fakeClient();
    const revalidate = createRevalidate(client);
    revalidate('meta');
    const flat = invalidated.map((k) => k[0]);
    expect(flat).toEqual(
      expect.arrayContaining(['stock-list', 'stock-meta', 'watch-universe']),
    );
    expect(flat).not.toContain('kline');
    expect(flat).not.toContain('sentiment');
  });

  it('"kline" hits all kline-derived caches and snapshot derivation', () => {
    const { client, invalidated } = fakeClient();
    const revalidate = createRevalidate(client);
    revalidate('kline');
    const flat = invalidated.map((k) => k[0]);
    expect(flat).toEqual(
      expect.arrayContaining(['kline', 'kline.bulk', 'stock.snapshots']),
    );
    expect(flat).not.toContain('sentiment');
  });

  it('"sentiment" hits the per-code and aggregate sentiment keys', () => {
    const { client, invalidated } = fakeClient();
    const revalidate = createRevalidate(client);
    revalidate('sentiment');
    const flat = invalidated.map((k) => k[0]);
    expect(flat).toEqual(expect.arrayContaining(['sentiment', 'sentiment.many']));
  });

  it('"all" includes meta + kline + sentiment scopes', () => {
    const { client, invalidated } = fakeClient();
    const revalidate = createRevalidate(client);
    revalidate('all');
    const flat = invalidated.map((k) => k[0]);
    for (const expected of [
      'stock-list',
      'stock-meta',
      'kline',
      'kline.bulk',
      'stock.snapshots',
      'sentiment',
      'sentiment.many',
    ]) {
      expect(flat).toContain(expected);
    }
  });

  it('"watch" is a no-op (SSE-driven; no react-query keys to evict)', () => {
    const { client, invalidated } = fakeClient();
    const revalidate = createRevalidate(client);
    revalidate('watch');
    expect(invalidated).toEqual([]);
  });
});
