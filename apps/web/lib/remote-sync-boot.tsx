'use client';

/**
 * Mounts the read-once + debounced-write remote-sync hooks for the
 * sectors / settings stores. Lives outside `lib/providers.tsx` so the
 * underlying GET requests only fire on routes that actually render the
 * workbench shell — root `layout.tsx` (which wraps every route,
 * including 404 / future static pages) no longer pays the boot cost.
 */

import { useEffect } from 'react';

import { startChannelActivitySubscription } from './socket/channel-activity-subscriber.js';
import { useSectorsRemoteSync } from './stores/sectors.store.js';
import { useSysCfgRemoteSync } from './stores/settings.store.js';

export function RemoteSyncBoot(): null {
  useSectorsRemoteSync();
  useSysCfgRemoteSync();
  useEffect(() => {
    startChannelActivitySubscription();
  }, []);
  return null;
}
