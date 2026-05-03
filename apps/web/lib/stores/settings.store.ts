/**
 * User settings (modules/07-frontend.md §6.1). Persisted to IndexedDB.
 * Holds theme + Slack push config + column preferences. Server-side
 * data never lives here — that's react-query's job.
 */

'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { idbStorage } from './idb-storage.js';

export type ThemeMode = 'light' | 'dark';

export interface SlackTarget {
  readonly channel: string;
  readonly webhookUrl: string;
}

interface SettingsState {
  readonly theme: ThemeMode;
  readonly slackTargets: readonly SlackTarget[];
  setTheme(theme: ThemeMode): void;
  addSlackTarget(target: SlackTarget): void;
  removeSlackTarget(channel: string): void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'light',
      slackTargets: [],
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
    }),
    {
      name: 'settings',
      storage: createJSONStorage(() => idbStorage('settings')),
      version: 1,
    },
  ),
);
