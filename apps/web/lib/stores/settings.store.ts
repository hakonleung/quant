/**
 * User settings (modules/07-frontend.md §6.1). Persisted to IndexedDB.
 * Holds theme + Slack push config + column preferences. Server-side
 * data never lives here — that's react-query's job.
 */

'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import {
  COLUMN_KEYS,
  DEFAULT_APPLIED_COLUMNS,
  isColumnKey,
  type ColumnKey,
} from '../eqty/columns.catalog.js';
import { idbStorage } from './idb-storage.js';

export type ThemeMode = 'light' | 'dark';

export interface SlackTarget {
  readonly channel: string;
  readonly webhookUrl: string;
}

interface SettingsState {
  readonly theme: ThemeMode;
  readonly slackTargets: readonly SlackTarget[];
  /**
   * E-1 list applied columns, in render order. Persisted globally; the
   * dynamic-sector evidence columns are appended at render time and are
   * not part of this list.
   */
  readonly appliedColumns: readonly ColumnKey[];
  setTheme(theme: ThemeMode): void;
  addSlackTarget(target: SlackTarget): void;
  removeSlackTarget(channel: string): void;
  setAppliedColumns(keys: readonly ColumnKey[]): void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'light',
      slackTargets: [],
      appliedColumns: DEFAULT_APPLIED_COLUMNS,
      setTheme: (theme) => {
        set({ theme });
      },
      addSlackTarget: (target) => {
        set((state) => {
          const next = state.slackTargets.filter((t) => t.channel !== target.channel);
          return { slackTargets: [...next, target] };
        });
      },
      removeSlackTarget: (channel) => {
        set((state) => ({
          slackTargets: state.slackTargets.filter((t) => t.channel !== channel),
        }));
      },
      setAppliedColumns: (keys) => {
        // De-dup while preserving order; drop unknown keys (catalog may
        // shrink between releases — old persisted entries become noise).
        const seen = new Set<ColumnKey>();
        const cleaned: ColumnKey[] = [];
        for (const k of keys) {
          if (!seen.has(k) && isColumnKey(k)) {
            seen.add(k);
            cleaned.push(k);
          }
        }
        set({ appliedColumns: cleaned });
      },
    }),
    {
      name: 'settings',
      storage: createJSONStorage(() => idbStorage('settings')),
      version: 2,
      // v1 → v2: legacy state has no `appliedColumns`; backfill with the
      // catalog defaults so the user keeps the columns they had been
      // implicitly seeing under the hard-coded layout.
      migrate: (persistedState, version) => {
        if (version >= 2) return persistedState;
        const state = (persistedState ?? {}) as Record<string, unknown>;
        return { ...state, appliedColumns: DEFAULT_APPLIED_COLUMNS };
      },
      // Drop columns that disappeared from the catalog after rehydration —
      // belt-and-suspenders for users whose persisted state was written by
      // a newer build that knew keys we no longer ship.
      onRehydrateStorage: () => (state) => {
        if (state === undefined) return;
        const known = new Set<string>(COLUMN_KEYS);
        const filtered = state.appliedColumns.filter((k) => known.has(k));
        if (filtered.length !== state.appliedColumns.length) {
          state.setAppliedColumns(filtered);
        }
      },
    },
  ),
);
