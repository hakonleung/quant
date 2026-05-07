'use client';

import type { BlacklistSnapshot } from '@quant/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchBlacklist } from '../api/blacklist.js';

const STALE_MS = 5 * 60_000;

/**
 * Cron-managed A-share blacklist. Used by `feat-sec-list` to filter
 * the synthetic "全 A" sector. 5-minute stale window — the daily cron
 * only mutates this once at 15:15 BJT, so even an hour-stale read is
 * fine in practice.
 */
export function useBlacklistQuery(): UseQueryResult<BlacklistSnapshot> {
  return useQuery({
    queryKey: ['blacklist'],
    queryFn: () => fetchBlacklist(),
    staleTime: STALE_MS,
  });
}

/** Convenience: empty Set when not yet loaded. */
export function useBlacklistSet(): ReadonlySet<string> {
  const q = useBlacklistQuery();
  return new Set(q.data?.codes ?? []);
}
