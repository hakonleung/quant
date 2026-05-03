/**
 * Client-side blacklist store (modules/07-frontend.md §4.4, §6).
 * Persisted to IndexedDB via the shared `idbStorage` adapter.
 */

'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { idbStorage } from './idb-storage.js';

export interface BlacklistEntry {
  readonly code: string;
  readonly name: string;
  /** ISO date the entry was added. */
  readonly addedAt: string;
  readonly note: string;
}

interface BlacklistState {
  readonly entries: readonly BlacklistEntry[];
  setEntries(rows: readonly BlacklistEntry[]): void;
  add(entry: BlacklistEntry): void;
  remove(code: string): void;
}

export const useBlacklistStore = create<BlacklistState>()(
  persist(
    (set) => ({
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
    }),
    {
      name: 'blacklist',
      storage: createJSONStorage(() => idbStorage('blacklist')),
      version: 1,
    },
  ),
);
