/**
 * Client-side blacklist store. Persistence rides on the Sys.Cfg blob —
 * see `settings.store.ts` (`useSysCfgRemoteSync`) which loads / saves
 * settings + blacklist as one backend record.
 */

'use client';

import type { BlacklistEntry } from '@quant/shared';
import { create } from 'zustand';

export type { BlacklistEntry };

interface BlacklistState {
  readonly entries: readonly BlacklistEntry[];
  setEntries(rows: readonly BlacklistEntry[]): void;
  add(entry: BlacklistEntry): void;
  remove(code: string): void;
}

export const useBlacklistStore = create<BlacklistState>()((set) => ({
  entries: [],
  setEntries: (rows) => {
    set({ entries: rows });
  },
  add: (entry) => {
    set((state) => {
      if (state.entries.some((e) => e.code === entry.code)) return state;
      return { entries: [...state.entries, entry] };
    });
  },
  remove: (code) => {
    set((state) => ({ entries: state.entries.filter((e) => e.code !== code) }));
  },
}));
