/**
 * Persisted EQTY workbench layout — pane mode (normal/minimized/
 * fullscreen) and side-column widths. Survives reloads via the IDB
 * adapter so the user's pinned layout is recovered on revisit.
 *
 * Pane mode is keyed by `Feat` id; the store falls back to the
 * `defaultMinimized` config flag for keys it has never seen, so adding
 * a new pane in `feat.ts` does not require migrating saved state.
 */

'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { idbStorage } from './idb-storage.js';

export type PaneMode = 'normal' | 'minimized' | 'fullscreen';

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
  /** Per-feat saved mode. Missing keys fall back to feat config. */
  readonly paneMode: Readonly<Record<string, PaneMode>>;
  readonly leftWidth: number;
  readonly rightWidth: number;
  setPaneMode(feat: string, mode: PaneMode): void;
  setLeftWidth(px: number): void;
  setRightWidth(px: number): void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      paneMode: {},
      leftWidth: LEFT_DEFAULT,
      rightWidth: RIGHT_DEFAULT,
      setPaneMode: (feat, mode) => {
        set((state) => ({ paneMode: { ...state.paneMode, [feat]: mode } }));
      },
      setLeftWidth: (px) => {
        set({ leftWidth: clamp(px, LEFT_MIN, LEFT_MAX) });
      },
      setRightWidth: (px) => {
        set({ rightWidth: clamp(px, RIGHT_MIN, RIGHT_MAX) });
      },
    }),
    {
      name: 'eqty-layout',
      storage: createJSONStorage(() => idbStorage('layout')),
      version: 1,
    },
  ),
);

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
