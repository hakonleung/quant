'use client';

/**
 * Selector hook for the global `channel.activity` Zustand store.
 *
 * Data persists across component mount/unmount cycles because the
 * underlying subscription lives in `channel-activity-subscriber.ts`,
 * started once from the app shell via `RemoteSyncBoot`.
 *
 * No subscribe/unsubscribe here — the singleton subscriber handles
 * that so navigating away does not clear the feed.
 */

import { useShallow } from 'zustand/react/shallow';

import {
  useChannelActivityStore,
  type ChannelActivityState,
} from '../stores/channel-activity.store.js';

export type { ChannelActivityState };

export function useChannelActivity(): ChannelActivityState {
  return useChannelActivityStore(
    useShallow((s) => ({
      status: s.status,
      rows: s.rows,
      error: s.error,
      maxRows: s.maxRows,
    })),
  );
}
