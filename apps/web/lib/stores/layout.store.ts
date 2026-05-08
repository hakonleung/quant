/**
 * Persisted EQTY workbench layout — feat-view mode (normal/minimized/
 * fullscreen) and side-column widths. Survives reloads via the IDB
 * adapter so the user's pinned layout is recovered on revisit.
 *
 * Mode is keyed by `Feat` id; the store falls back to the
 * `defaultMinimized` config flag for keys it has never seen, so adding
 * a new feat in `feat.ts` does not require migrating saved state.
 *
 * `appMode` is the top-level chrome toggle: `'regular'` mounts the full
 * workbench (TopBar + columns); `'term'` collapses the chrome and
 * mounts only TERM.MAIN. The mode persists with the rest of the layout
 * so a refresh keeps the user where they were.
 */

'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { idbStorage } from './idb-storage.js';

export type FeatViewMode = 'normal' | 'minimized' | 'fullscreen';
export type AppMode = 'regular' | 'term';

const LEFT_DEFAULT = 280;
const RIGHT_DEFAULT = 480;
const LEFT_MIN = 160;
const LEFT_MAX = 480;
const RIGHT_MIN = 280;
const RIGHT_MAX = 720;

export const LAYOUT_LIMITS = {
  leftMin: LEFT_MIN,
  leftMax: LEFT_MAX,
  rightMin: RIGHT_MIN,
  rightMax: RIGHT_MAX,
} as const;

interface LayoutState {
  /** Per-feat saved view mode. Missing keys fall back to feat config. */
  readonly featViewMode: Readonly<Record<string, FeatViewMode>>;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly appMode: AppMode;
  setFeatViewMode(feat: string, mode: FeatViewMode): void;
  setLeftWidth(px: number): void;
  setRightWidth(px: number): void;
  setAppMode(mode: AppMode): void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      featViewMode: {},
      leftWidth: LEFT_DEFAULT,
      rightWidth: RIGHT_DEFAULT,
      appMode: 'regular',
      setFeatViewMode: (feat, mode) => {
        set((state) => ({ featViewMode: { ...state.featViewMode, [feat]: mode } }));
      },
      setLeftWidth: (px) => {
        set({ leftWidth: clamp(px, LEFT_MIN, LEFT_MAX) });
      },
      setRightWidth: (px) => {
        set({ rightWidth: clamp(px, RIGHT_MIN, RIGHT_MAX) });
      },
      setAppMode: (mode) => {
        set({ appMode: mode });
      },
    }),
    {
      name: 'eqty-layout',
      storage: createJSONStorage(() => idbStorage('layout')),
      version: 3,
    },
  ),
);

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
