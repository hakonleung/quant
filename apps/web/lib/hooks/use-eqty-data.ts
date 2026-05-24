'use client';

import type {
  KlineBar,
  MarketSentiment,
  Sentiment,
  StockMetaDto,
  StockSnapshotDto,
} from '@quant/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import { isValidWatchCode, type WatchMarket } from '@quant/shared';

import {
  analyzeManySentiment,
  analyzeSentiment,
  getCachedMarketSentiment,
  getCachedSentiment,
  getStockMeta,
  listKline,
  listKlineBulk,
  listStockSnapshots,
  type KlineBulkResponse,
} from '../api/endpoints.js';

/**
 * Cheap shape-based market inference for sentiment hooks: 6 digits → 'a',
 * 4-5 digits → 'hk', alpha (incl. `<secid>.TICKER`) → 'us'. Mirrors the
 * binding in ui-cmd/global-cells.ts so panel button + `R` shortcut agree.
 * Falls back to 'a' on ambiguity — the BE refine will reject with a
 * clear message.
 */
function inferMarketFromCode(code: string): WatchMarket {
  for (const m of ['a', 'hk', 'us'] as const) {
    if (isValidWatchCode(m, code)) return m;
  }
  return 'a';
}

const sentimentKey = (
  market: WatchMarket,
  code: string,
): readonly ['sentiment', WatchMarket, string] => ['sentiment', market, code];

/**
 * Stable react-query key for an aggregate analysis. Keying on the
 * canonicalised join means re-ordered or duplicated input codes share
 * the same cache entry — same contract as the Python cache hash.
 */
const marketSentimentKey = (
  market: WatchMarket,
  codes: readonly string[],
): readonly ['sentiment.many', WatchMarket, string] => [
  'sentiment.many',
  market,
  [...new Set(codes)].sort().join(','),
];

export function useStockMetaQuery(code: string): UseQueryResult<StockMetaDto | null> {
  return useQuery({
    queryKey: ['stock-meta', code],
    queryFn: () => getStockMeta(code),
    enabled: code.length > 0,
    staleTime: 60 * 60 * 1000,
  });
}

export function useKline(code: string, range: string): UseQueryResult<readonly KlineBar[]> {
  return useQuery({
    queryKey: ['kline', code, range],
    queryFn: () => listKline(code, range),
    enabled: code.length > 0,
    // Daily kline updates after market close; aggressive caching is fine.
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Bulk last-N kline read. One HTTP request returns
 * `Record<code, bars>`, replacing the previous per-row useQueries
 * fan-out which saturated the browser socket pool
 * (ERR_INSUFFICIENT_RESOURCES) on big universes.
 */
export interface BatchKlineState {
  readonly byCode: ReadonlyMap<string, readonly KlineBar[]>;
  readonly isLoading: boolean;
  readonly readyCount: number;
}

export interface UseKlineBulkOptions {
  /**
   * Default enabled rule — `codes.length > 0`. Override to `true` when
   * passing an empty `codes` array intentionally means "the server
   * should expand to the full universe". Override to `false` to gate
   * the query off entirely (e.g. before a parent dependency resolves).
   */
  readonly enabled?: boolean;
}

export function useKlineBulk(
  codes: readonly string[],
  n: number,
  opts: UseKlineBulkOptions = {},
): BatchKlineState {
  // Canonical key — sorted + deduped — so re-orderings reuse the cache.
  const keyCodes = useMemo(() => [...new Set(codes)].sort(), [codes]);
  // The `[]` case is now load-bearing: callers use it to mean "fetch
  // every code the server knows about" (the All sector, the sectors
  // panel's universe-wide chg% map). The default enabled rule still
  // gates out the no-data-yet path so a transiently-empty subset
  // doesn't accidentally fan out into a full-universe pull.
  const enabled = opts.enabled ?? keyCodes.length > 0;
  const query = useQuery<KlineBulkResponse>({
    queryKey: ['kline.bulk', n, keyCodes.join(',')] as const,
    queryFn: () => listKlineBulk(keyCodes, n),
    enabled,
    staleTime: 60 * 60 * 1000,
    // Bulk kline can be a few MB per query (universe-wide pull). The
    // default 5-min retention chains those across rapid sector swaps
    // and balloons heap. 60 s is short enough that an inactive sector
    // releases its kline chunk soon after the user moves away, but
    // long enough that flipping back-and-forth between two sectors
    // still hits the cache.
    gcTime: 60 * 1000,
  });
  return useMemo(() => {
    const byCode = new Map<string, readonly KlineBar[]>();
    if (query.data !== undefined) {
      for (const [code, bars] of Object.entries(query.data)) {
        byCode.set(code, bars);
      }
    }
    return {
      byCode,
      isLoading: query.isLoading || query.isFetching,
      readyCount: byCode.size,
    };
  }, [query.data, query.isLoading, query.isFetching]);
}

export interface SnapshotsState {
  readonly byCode: ReadonlyMap<string, StockSnapshotDto>;
  readonly isLoading: boolean;
}

export interface UseStockSnapshotsOptions {
  readonly enabled?: boolean;
}

/**
 * meta + price-derived metrics for the given codes. Stays gated off until
 * the caller has at least one applied column that needs the snapshot
 * fetch (`appliedNeedsSnapshot(applied)`); the empty-codes case stays a
 * no-op. Cache key is canonical (sorted + de-duped) so re-orderings
 * share state with the bulk-kline pattern.
 */
export function useStockSnapshots(
  codes: readonly string[],
  opts: UseStockSnapshotsOptions = {},
): SnapshotsState {
  const keyCodes = useMemo(() => [...new Set(codes)].sort(), [codes]);
  // Caller is in charge of gating the empty-codes case via `enabled` —
  // the FE convention now mirrors `kline/bulk` where an empty list
  // means "full universe expansion server-side", not "skip the call".
  const enabled = opts.enabled ?? keyCodes.length > 0;
  const query = useQuery<readonly StockSnapshotDto[]>({
    queryKey: ['stock.snapshots', keyCodes.join(',')] as const,
    queryFn: () => listStockSnapshots(keyCodes).then((rows) => [...rows]),
    enabled,
    staleTime: 60 * 60 * 1000,
    // Snapshots travel with the universe + applied columns; user can
    // pivot quickly between sectors. 60 s gcTime is the same trade-off
    // as bulk-kline above — short enough not to hoard, long enough to
    // survive one ↔ another flip.
    gcTime: 60 * 1000,
  });
  return useMemo(() => {
    const byCode = new Map<string, StockSnapshotDto>();
    if (query.data !== undefined) {
      for (const row of query.data) byCode.set(row.meta.code, row);
    }
    return { byCode, isLoading: query.isLoading || query.isFetching };
  }, [query.data, query.isLoading, query.isFetching]);
}

/**
 * Default render path for the sentiment panel. Hits the BFF GET
 * (cache-only — never invokes the LLM); a 404 from the cache surfaces
 * here as `data === null` so the panel renders an empty state.
 */
export function useSentiment(code: string): UseQueryResult<Sentiment | null> {
  const market = inferMarketFromCode(code);
  return useQuery({
    queryKey: sentimentKey(market, code),
    queryFn: () => getCachedSentiment(code, market),
    enabled: code.length > 0,
    // 5 min: cache-only reads are cheap and the underlying parquet
    // updates only when the user clicks FETCH.
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * FETCH button handler. POSTs to analyze_one (paid LLM call) and on
 * success invalidates {@link useSentiment} so the cached-read query
 * re-fetches the now-warm row — single source of truth for the panel
 * stays the GET query (modules/07-frontend.md §4.2).
 */
export function useAnalyzeSentiment(
  code: string,
): UseMutationResult<Sentiment, Error, void, unknown> {
  const qc = useQueryClient();
  const market = inferMarketFromCode(code);
  return useMutation({
    mutationKey: ['sentiment.analyze', market, code],
    mutationFn: async (): Promise<Sentiment> => analyzeSentiment(code, market),
    onSuccess: (data) => {
      qc.setQueryData<Sentiment | null>(sentimentKey(market, code), data);
      void qc.invalidateQueries({ queryKey: sentimentKey(market, code) });
    },
  });
}

/**
 * Aggregate (board / sector) cached read. Mirrors {@link useSentiment}:
 * default render path; never invokes the LLM.
 */
export function useMarketSentiment(
  codes: readonly string[],
): UseQueryResult<MarketSentiment | null> {
  const market = codes.length > 0 ? inferMarketFromCode(codes[0] ?? '') : 'a';
  return useQuery({
    queryKey: marketSentimentKey(market, codes),
    queryFn: () => getCachedMarketSentiment(codes, market),
    enabled: codes.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Per-sector ANALYZE button. POSTs the member codes; on success writes
 * the result back into {@link useMarketSentiment}'s cache and
 * invalidates so the GET query re-fetches the warm aggregate row.
 */
export function useAnalyzeMany(
  codes: readonly string[],
): UseMutationResult<MarketSentiment, Error, void, unknown> {
  const qc = useQueryClient();
  const market = codes.length > 0 ? inferMarketFromCode(codes[0] ?? '') : 'a';
  return useMutation({
    mutationKey: ['sentiment.analyze.many', market, ...codes],
    mutationFn: async (): Promise<MarketSentiment> => analyzeManySentiment(codes, market),
    onSuccess: (data) => {
      qc.setQueryData<MarketSentiment | null>(marketSentimentKey(market, codes), data);
      void qc.invalidateQueries({ queryKey: marketSentimentKey(market, codes) });
    },
  });
}
