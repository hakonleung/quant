'use client';

/**
 * `useGroups` hook — owned by the WATCH add-form. Lives in its own
 * file so the form component stays under the 400-line ceiling. The
 * hook re-fetches when `refresh()` is called, which the form invokes
 * after a successful new-group creation so the dropdown reflects the
 * new entry without a page reload.
 */

import { useCallback, useEffect, useState } from 'react';

import type { WatchGroup } from '@quant/shared';

import { fetchGroups } from './watch-add-api.js';

export interface UseWatchGroupsResult {
  readonly groups: readonly WatchGroup[];
  readonly refresh: () => void;
}

export function useWatchGroups(): UseWatchGroupsResult {
  const [groups, setGroups] = useState<readonly WatchGroup[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchGroups()
      .then((g) => {
        if (!cancelled) setGroups(g);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return (): void => {
      cancelled = true;
    };
  }, [tick]);
  const refresh = useCallback((): void => {
    setTick((t) => t + 1);
  }, []);
  return { groups, refresh };
}
