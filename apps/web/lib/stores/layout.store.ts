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

import { Feat } from '../eqty/feat.js';

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

/**
 * One-click layout snapshots — UX plan §P2-1. Each preset bundles a
 * left/right column width and a per-Feat view-mode override so the
 * user can flip between "chart focus", "list focus" and "AI focus"
 * without dragging dividers + toggling four panes.
 *
 * Presets are *applied* (mutate the live state) rather than swapped —
 * the user keeps whatever changes they make afterwards. Any Feat not
 * mentioned in `featViewMode` falls back to its `defaultMinimized`
 * config, so adding a new Feat doesn't require migrating presets.
 */
export interface LayoutPreset {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly featViewMode: Readonly<Record<string, FeatViewMode>>;
}

export const BUILTIN_PRESETS: readonly LayoutPreset[] = [
  {
    id: 'default',
    label: '默认',
    description: '三列均衡 — SEC + LIST 左 / CHART 中 / AI + LDG + WATCH 右。',
    leftWidth: LEFT_DEFAULT,
    rightWidth: RIGHT_DEFAULT,
    featViewMode: {
      [Feat.EquityChart]: 'normal',
      [Feat.EquityList]: 'normal',
      [Feat.AISec]: 'normal',
      [Feat.AIEq]: 'normal',
    },
  },
  {
    id: 'chart-focus',
    label: '只看图',
    description: '左右收窄到最小，把所有视觉权重让给 EQ.CHART。',
    leftWidth: LEFT_MIN,
    rightWidth: RIGHT_MIN,
    featViewMode: {
      [Feat.EquityChart]: 'normal',
      [Feat.SectorList]: 'minimized',
      [Feat.EquityList]: 'minimized',
      [Feat.AISec]: 'minimized',
      [Feat.AIEq]: 'minimized',
      [Feat.AIMd]: 'minimized',
      [Feat.WatchLive]: 'minimized',
      [Feat.Ledger]: 'minimized',
    },
  },
  {
    id: 'list-focus',
    label: '只看清单',
    description: '左列拉到最大读 EQ.LIST；其它面板让位。',
    leftWidth: LEFT_MAX,
    rightWidth: RIGHT_MIN,
    featViewMode: {
      [Feat.SectorList]: 'normal',
      [Feat.EquityList]: 'normal',
      [Feat.EquityChart]: 'minimized',
      [Feat.AISec]: 'minimized',
      [Feat.AIEq]: 'minimized',
      [Feat.AIMd]: 'minimized',
      [Feat.WatchLive]: 'minimized',
      [Feat.Ledger]: 'minimized',
    },
  },
  {
    id: 'ai-focus',
    label: 'AI 焦点',
    description: '右列拉到最大，AI.SEC + AI.EQ + AI.MD 全展开。',
    leftWidth: LEFT_MIN,
    rightWidth: RIGHT_MAX,
    featViewMode: {
      [Feat.EquityChart]: 'normal',
      [Feat.EquityList]: 'minimized',
      [Feat.SectorList]: 'minimized',
      [Feat.AISec]: 'normal',
      [Feat.AIEq]: 'normal',
      [Feat.AIMd]: 'normal',
      [Feat.WatchLive]: 'minimized',
      [Feat.Ledger]: 'minimized',
    },
  },
];

interface LayoutState {
  /** Per-feat saved view mode. Missing keys fall back to feat config. */
  readonly featViewMode: Readonly<Record<string, FeatViewMode>>;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly appMode: AppMode;
  /**
   * Id of the preset most recently applied via `applyPreset`. Cleared
   * when the user manually drags a divider or toggles a Feat view
   * mode, so the active-preset highlight in SYS.CFG / cmd palette
   * accurately reflects "this is what's on screen right now".
   */
  readonly activePresetId: string | null;
  setFeatViewMode(feat: string, mode: FeatViewMode): void;
  setLeftWidth(px: number): void;
  setRightWidth(px: number): void;
  setAppMode(mode: AppMode): void;
  /** Apply a layout preset by id. No-op when the id is unknown. */
  readonly applyPreset: (presetId: string) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      featViewMode: {},
      leftWidth: LEFT_DEFAULT,
      rightWidth: RIGHT_DEFAULT,
      appMode: 'regular',
      activePresetId: null,
      setFeatViewMode: (feat, mode) => {
        set((state) => ({
          featViewMode: { ...state.featViewMode, [feat]: mode },
          // Manual edits invalidate the preset highlight — the layout
          // is no longer literally "the chart-focus preset", it's the
          // user's own arrangement.
          activePresetId: null,
        }));
      },
      setLeftWidth: (px) => {
        set({ leftWidth: clamp(px, LEFT_MIN, LEFT_MAX), activePresetId: null });
      },
      setRightWidth: (px) => {
        set({ rightWidth: clamp(px, RIGHT_MIN, RIGHT_MAX), activePresetId: null });
      },
      setAppMode: (mode) => {
        set({ appMode: mode });
      },
      applyPreset: (presetId) => {
        const preset = BUILTIN_PRESETS.find((p) => p.id === presetId);
        if (preset === undefined) return;
        set({
          leftWidth: clamp(preset.leftWidth, LEFT_MIN, LEFT_MAX),
          rightWidth: clamp(preset.rightWidth, RIGHT_MIN, RIGHT_MAX),
          // Replace (not merge) so "chart-focus" reliably minimises
          // every Feat the preset names — a stale `normal` mode from
          // a previous preset can't leak through.
          featViewMode: { ...preset.featViewMode },
          activePresetId: preset.id,
        });
      },
    }),
    {
      name: 'eqty-layout',
      storage: createJSONStorage(() => idbStorage('layout')),
      // v4 — added `activePresetId`. Existing v3 payloads load fine
      // (extra field defaults to null in the initial state above).
      version: 4,
    },
  ),
);

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
