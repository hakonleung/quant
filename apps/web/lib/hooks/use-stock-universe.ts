'use client';

/**
 * Cross-market stock universe for the M-0 / W-0 search dropdown.
 *
 * - A-stock rows come from `/api/stocks` (StockMetaDto, includes pinyin)
 * - HK / US rows come from `/api/watch/universe?market=…` (StockBasic)
 *
 * All three are flattened into a single `UniverseStock[]` so callers
 * can search browser-side without a per-keystroke RPC. A market filter
 * lets the consumer (e.g. the top-bar M-0 panel) restrict to a single
 * market without re-fetching.
 */

import {
  StockBasicSchema,
  type StockBasic,
  type StockMetaDto,
  type WatchMarket,
} from '@quant/shared';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';

import { apiGet } from '../api/client.js';
import { useStockList } from './use-stock-list.js';

export interface UniverseStock {
  readonly market: WatchMarket;
  readonly code: string;
  readonly name: string;
  readonly pinyin: string;
}

const StockBasicListSchema = z.array(StockBasicSchema);

async function fetchWatchUniverse(market: 'hk' | 'us'): Promise<readonly StockBasic[]> {
  try {
    return await apiGet(
      `/api/watch/universe?market=${market}`,
      (raw) => StockBasicListSchema.parse(raw),
    );
  } catch {
    return [];
  }
}

function metaToUniverse(rows: readonly StockMetaDto[]): readonly UniverseStock[] {
  return rows.map((r) => ({
    market: 'a' as const,
    code: r.code,
    name: r.name,
    pinyin: r.name_pinyin,
  }));
}

function basicToUniverse(
  rows: readonly StockBasic[],
  market: WatchMarket,
): readonly UniverseStock[] {
  return rows.map((r) => ({ market, code: r.code, name: r.name, pinyin: '' }));
}

/**
 * `marketFilter` undefined ⇒ all three markets combined.
 * The hook returns a stable, memoized array so the consumer can feed it
 * into a `useMemo` search without re-running on identity churn.
 */
export function useStockUniverse(marketFilter?: WatchMarket): {
  readonly data: readonly UniverseStock[];
  readonly isLoading: boolean;
} {
  const wantA = marketFilter === undefined || marketFilter === 'a';
  const wantHk = marketFilter === undefined || marketFilter === 'hk';
  const wantUs = marketFilter === undefined || marketFilter === 'us';

  const aQuery = useStockList();
  const watchQueries = useQueries({
    queries: [
      {
        queryKey: ['watch-universe', 'hk'] as const,
        queryFn: () => fetchWatchUniverse('hk'),
        staleTime: 60 * 60 * 1000,
        enabled: wantHk,
      },
      {
        queryKey: ['watch-universe', 'us'] as const,
        queryFn: () => fetchWatchUniverse('us'),
        staleTime: 60 * 60 * 1000,
        enabled: wantUs,
      },
    ],
  });

  const [hkQuery, usQuery] = watchQueries;

  const data = useMemo<readonly UniverseStock[]>(() => {
    const out: UniverseStock[] = [];
    if (wantA && aQuery.data !== undefined) out.push(...metaToUniverse(aQuery.data));
    if (wantHk && hkQuery.data !== undefined) out.push(...basicToUniverse(hkQuery.data, 'hk'));
    if (wantUs && usQuery.data !== undefined) out.push(...basicToUniverse(usQuery.data, 'us'));
    return out;
  }, [wantA, wantHk, wantUs, aQuery.data, hkQuery.data, usQuery.data]);

  const isLoading =
    (wantA && aQuery.isLoading) ||
    (wantHk && hkQuery.isLoading) ||
    (wantUs && usQuery.isLoading);

  return { data, isLoading };
}
