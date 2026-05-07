'use client';

/**
 * Bridge-side implementation of `RevalidateScope`. Maps each scope to
 * the matching `react-query` key prefixes and any zustand stores the
 * scope owns. Any non-matching keys are left alone.
 *
 * Pure factory — call from `useTerminal` once and pass the resulting
 * function via `LiveRunnerDeps.revalidate` AND `CommandStores.revalidate`.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { RevalidateScope } from '@quant/terminal';

import { fetchSectors } from '../api/sectors.js';
import { useSectorsStore } from '../stores/sectors.store.js';

/**
 * Per-scope query-key prefixes the bridge invalidates on a revalidate
 * call. Centralising the table keeps `createRevalidate` itself a thin
 * dispatcher (compliance with eslint `complexity` rule) and makes
 * adding new scopes a one-line change.
 */
const QUERY_KEYS_BY_SCOPE: Readonly<Record<string, readonly readonly string[][]>> = {
  meta: [
    ['stock-list'],
    ['stock-meta'],
    // Universe shapes (HK / US baskets) feed the watch add-form; the
    // gateway re-derives them from the same parquet a meta scan
    // refreshes, so they belong in the meta bucket.
    ['watch-universe'],
  ],
  kline: [['kline'], ['kline.bulk'], ['stock.snapshots']],
  sentiment: [['sentiment'], ['sentiment.many']],
  ta: [['ta']],
};

export function createRevalidate(qc: QueryClient): (scope: RevalidateScope) => void {
  return (scope) => {
    for (const [bucket, keys] of Object.entries(QUERY_KEYS_BY_SCOPE)) {
      if (scope === bucket || scope === 'all') {
        for (const key of keys) {
          void qc.invalidateQueries({ queryKey: [...key] });
        }
      }
    }
    if (scope === 'sectors' || scope === 'all') {
      // Sectors live in zustand, not react-query. Re-fetch and push.
      void fetchSectors()
        .then((rows) => {
          useSectorsStore.getState().setSectors(rows);
        })
        .catch(() => {
          /* best-effort — leave the local store untouched on error */
        });
    }
    // 'watch' is intentionally a no-op: the watch state is SSE-driven
    // (`/api/watch/stream`), and the next snapshot will arrive within
    // ~1s of the gateway accepting the write. Including the scope in
    // the union keeps the API symmetric for callers and lets us
    // wire a cache here later if needed.
  };
}
