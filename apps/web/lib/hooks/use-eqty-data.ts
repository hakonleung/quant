'use client';

import type { BlotterRow, KlineBar, MarketSentiment, Sentiment, StockMetaDto } from '@quant/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  analyzeManySentiment,
  analyzeSentiment,
  getCachedMarketSentiment,
  getCachedSentiment,
  getStockMeta,
  listKline,
  listSectorHits,
} from '../api/endpoints.js';

const sentimentKey = (code: string): readonly ['sentiment', string] => ['sentiment', code];

/**
 * Stable react-query key for an aggregate analysis. Keying on the
 * canonicalised join means re-ordered or duplicated input codes share
 * the same cache entry — same contract as the Python cache hash.
 */
const marketSentimentKey = (codes: readonly string[]): readonly ['sentiment.many', string] => [
  'sentiment.many',
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

export function useSectorHits(ids: readonly string[]): UseQueryResult<readonly BlotterRow[]> {
  return useQuery({
    queryKey: ['sector-hits', ids],
    queryFn: () => listSectorHits(ids),
    staleTime: 30_000,
  });
}

/**
 * Default render path for the sentiment panel. Hits the BFF GET
 * (cache-only — never invokes the LLM); a 404 from the cache surfaces
 * here as `data === null` so the panel renders an empty state.
 */
export function useSentiment(code: string): UseQueryResult<Sentiment | null> {
  return useQuery({
    queryKey: sentimentKey(code),
    queryFn: () => getCachedSentiment(code),
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
  return useMutation({
    mutationKey: ['sentiment.analyze', code],
    mutationFn: async (): Promise<Sentiment> => analyzeSentiment(code),
    onSuccess: (data) => {
      qc.setQueryData<Sentiment | null>(sentimentKey(code), data);
      void qc.invalidateQueries({ queryKey: sentimentKey(code) });
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
  return useQuery({
    queryKey: marketSentimentKey(codes),
    queryFn: () => getCachedMarketSentiment(codes),
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
  return useMutation({
    mutationKey: ['sentiment.analyze.many', ...codes],
    mutationFn: async (): Promise<MarketSentiment> => analyzeManySentiment(codes),
    onSuccess: (data) => {
      qc.setQueryData<MarketSentiment | null>(marketSentimentKey(codes), data);
      void qc.invalidateQueries({ queryKey: marketSentimentKey(codes) });
    },
  });
}
