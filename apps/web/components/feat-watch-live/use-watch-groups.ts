'use client';

/**
 * `useWatchGroups` — react-query hook backing the WATCH add-form
 * dropdown and the live-pane group config. Sharing the same query key
 * lets the form's `refresh` invalidate the cache for both callers in
 * one shot, and tab-flips inside USR re-use the cached groups list.
 */

import type { WatchGroup } from '@quant/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { getClientConfig } from '../../lib/config/config-center-next-client-getter.js';
import { fetchGroups } from './watch-add-api.js';

export const WATCH_GROUPS_KEY = ['watch', 'groups'] as const;

export interface UseWatchGroupsResult {
  readonly groups: readonly WatchGroup[];
  readonly refresh: () => void;
}

export function useWatchGroups(): UseWatchGroupsResult {
  const qc = useQueryClient();
  const q = useQuery<readonly WatchGroup[]>({
    queryKey: WATCH_GROUPS_KEY,
    queryFn: fetchGroups,
    staleTime: getClientConfig().ui.reactQuery.watchGroupsStaleTimeMs,
    placeholderData: EMPTY_GROUPS,
  });
  const refresh = useCallback((): void => {
    void qc.invalidateQueries({ queryKey: WATCH_GROUPS_KEY });
  }, [qc]);
  return { groups: q.data ?? EMPTY_GROUPS, refresh };
}

const EMPTY_GROUPS: readonly WatchGroup[] = Object.freeze([]);
