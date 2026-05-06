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

export function createRevalidate(qc: QueryClient): (scope: RevalidateScope) => void {
  return (scope) => {
    if (scope === 'meta' || scope === 'all') {
      void qc.invalidateQueries({ queryKey: ['stock-list'] });
      void qc.invalidateQueries({ queryKey: ['stock-meta'] });
      // Universe shapes (HK / US baskets) feed the watch add-form; the
      // gateway re-derives them from the same parquet a meta scan
      // refreshes, so they belong in the meta bucket.
      void qc.invalidateQueries({ queryKey: ['watch-universe'] });
    }
    if (scope === 'kline' || scope === 'all') {
      void qc.invalidateQueries({ queryKey: ['kline'] });
      void qc.invalidateQueries({ queryKey: ['kline.bulk'] });
      void qc.invalidateQueries({ queryKey: ['stock.snapshots'] });
    }
    if (scope === 'sentiment' || scope === 'all') {
      void qc.invalidateQueries({ queryKey: ['sentiment'] });
      void qc.invalidateQueries({ queryKey: ['sentiment.many'] });
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
