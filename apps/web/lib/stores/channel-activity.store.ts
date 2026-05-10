'use client';

/**
 * Global Zustand store for `channel.activity` socket events.
 *
 * Keyed by `baseId(activity.id)` so that pending → sent/failed status
 * transitions collapse onto the same row instead of appending a new one.
 */

import type { ChannelActivity } from '@quant/shared';
import { create } from 'zustand';

export interface ChannelActivityState {
  readonly status: 'connecting' | 'open' | 'error';
  readonly rows: readonly ChannelActivity[];
  readonly error: string | null;
  readonly maxRows: number;
}

interface ChannelActivityActions {
  pushActivity(incoming: ChannelActivity): void;
  setStatus(s: 'connecting' | 'open' | 'error', error?: string): void;
}

type ChannelActivityStore = ChannelActivityState & ChannelActivityActions;

export const DEFAULT_MAX_ROWS = 500;

export const useChannelActivityStore = create<ChannelActivityStore>()((set) => ({
  status: 'connecting',
  rows: [],
  error: null,
  maxRows: DEFAULT_MAX_ROWS,

  pushActivity: (incoming) => {
    set((s) => {
      const idx = s.rows.findIndex((r) => baseId(r.id) === baseId(incoming.id));
      const next =
        idx >= 0
          ? [...s.rows.slice(0, idx), incoming, ...s.rows.slice(idx + 1)]
          : [incoming, ...s.rows];
      return {
        rows: next.length > s.maxRows ? next.slice(0, s.maxRows) : next,
        status: 'open' as const,
        error: null,
      };
    });
  },

  setStatus: (status, error) => {
    set({ status, error: error ?? null });
  },
}));

/** Strip worker-appended `:done`/`:err`/`:failed` suffix for upsert keying. */
function baseId(id: string): string {
  const colon = id.lastIndexOf(':');
  if (colon < 0) return id;
  const tail = id.slice(colon + 1);
  if (tail === 'done' || tail === 'err' || tail === 'failed') return id.slice(0, colon);
  return id;
}
