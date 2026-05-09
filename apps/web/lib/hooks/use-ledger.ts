'use client';

/**
 * React-query hooks for the personal-ledger feature.
 *
 *   - `useLedgerEntries`   — list raw entries (persisted shape)
 *   - `useLedgerEnriched`  — derived + enriched view, memoised on entries
 *   - `useLedgerMutations` — bundle create / patch / delete / import
 *   - `useLedgerCachedAnalysis` / `useLedgerAnalyzeMutation` — AI side
 */

import {
  enrichEntries,
  validateLedger,
  type EnrichedLedgerEntry,
  type LedgerAnalysis,
  type LedgerEntry,
  type LedgerSnapshot,
} from '@quant/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  analyzeLedger,
  createLedgerEntry,
  deleteLedgerEntry,
  getCachedLedgerAnalysis,
  importLedger,
  listLedgerEntries,
  patchLedgerEntry,
} from '../api/endpoints.js';

const ENTRIES_KEY = ['ledger', 'entries'] as const;
const CACHED_ANALYSIS_KEY = ['ledger', 'analysis', 'cached'] as const;

export function useLedgerEntries(): UseQueryResult<readonly LedgerEntry[]> {
  return useQuery({
    queryKey: ENTRIES_KEY,
    queryFn: () => listLedgerEntries(),
    // 5 min: every mutation (create/patch/remove/import) calls
    // `invalidate()` so the staleTime can't mask user-driven writes.
    // Tab-flips (USR LDG ↔ WATCH ↔ CFG) within 5 min reuse the cache.
    staleTime: 5 * 60_000,
  });
}

/**
 * Memoised enriched view: only re-runs when entries change. Returns
 * `null` until the first fetch completes (so callers can short-circuit
 * before an empty array becomes visible).
 */
export function useLedgerEnriched(): {
  entries: readonly LedgerEntry[];
  enriched: readonly EnrichedLedgerEntry[];
  loading: boolean;
  error: string | null;
} {
  const q = useLedgerEntries();
  const entries = q.data ?? [];
  const enriched = useMemo(() => {
    const validation = validateLedger(entries);
    if (!validation.ok) return [];
    return enrichEntries(entries);
  }, [entries]);
  return {
    entries,
    enriched,
    loading: q.isLoading,
    error: q.error instanceof Error ? q.error.message : null,
  };
}

interface LedgerMutations {
  readonly create: UseMutationResult<LedgerEntry, Error, LedgerEntry>;
  readonly patch: UseMutationResult<
    LedgerEntry,
    Error,
    { date: string; pnlAmount?: string; closingPosition?: string | null }
  >;
  readonly remove: UseMutationResult<void, Error, string>;
  readonly importEntries: UseMutationResult<LedgerSnapshot, Error, readonly LedgerEntry[]>;
}

export function useLedgerMutations(): LedgerMutations {
  const qc = useQueryClient();
  const invalidate = (): Promise<void> => {
    return Promise.all([
      qc.invalidateQueries({ queryKey: ENTRIES_KEY }),
      qc.invalidateQueries({ queryKey: CACHED_ANALYSIS_KEY }),
    ]).then(() => undefined);
  };
  const create = useMutation({
    mutationFn: (entry: LedgerEntry) => createLedgerEntry(entry),
    onSuccess: invalidate,
  });
  const patch = useMutation({
    mutationFn: (args: { date: string; pnlAmount?: string; closingPosition?: string | null }) => {
      const body: { pnlAmount?: string; closingPosition?: string | null } = {};
      if (args.pnlAmount !== undefined) body.pnlAmount = args.pnlAmount;
      if (Object.prototype.hasOwnProperty.call(args, 'closingPosition')) {
        body.closingPosition = args.closingPosition ?? null;
      }
      return patchLedgerEntry(args.date, body);
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (date: string) => deleteLedgerEntry(date),
    onSuccess: invalidate,
  });
  const importEntries = useMutation({
    mutationFn: (entries: readonly LedgerEntry[]) => importLedger(entries),
    onSuccess: invalidate,
  });
  return { create, patch, remove, importEntries };
}

export function useLedgerCachedAnalysis(): UseQueryResult<LedgerAnalysis | null> {
  return useQuery({
    queryKey: CACHED_ANALYSIS_KEY,
    queryFn: () => getCachedLedgerAnalysis(),
    staleTime: 5 * 60_000,
  });
}

export function useLedgerAnalyzeMutation(): UseMutationResult<LedgerAnalysis, Error, boolean> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bypassCache: boolean) => analyzeLedger(bypassCache),
    onSuccess: (data) => {
      qc.setQueryData(CACHED_ANALYSIS_KEY, data);
    },
  });
}
