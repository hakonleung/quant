/**
 * Zustand store backing the keyboard engine's `UiCtx`.
 *
 * Mutations here are synchronous and fired in response to UI command
 * dispatches (e.g. `g m` sets `activeFeat = 'MKT'`). The engine reads
 * via `useFocusStore.getState()` inside the keydown handler — no React
 * re-render per keystroke.
 */

import { create } from 'zustand';

import { Feat } from '../../eqty/feat.js';
import type { UiCtx } from '../types.js';

export interface FocusState {
  readonly activeFeat: Feat | null;
  readonly fullscreen: Feat | null;
  readonly subFocus: readonly string[];
  readonly modalOpen: boolean;
  /** True when the keyboard hint floating window is visible. */
  readonly hintOpen: boolean;
  /** True when the hint window is shown as a minimized corner badge. */
  readonly hintMinimized: boolean;
}

export interface FocusActions {
  setActive(f: Feat | null): void;
  setFullscreen(f: Feat | null): void;
  toggleFullscreen(f: Feat): void;
  pushSubFocus(tag: string): void;
  popSubFocus(): void;
  setModalOpen(open: boolean): void;
  setHintOpen(open: boolean): void;
  toggleHintOpen(): void;
  setHintMinimized(min: boolean): void;
}

export const useFocusStore = create<FocusState & FocusActions>((set) => ({
  activeFeat: null,
  fullscreen: null,
  subFocus: [],
  modalOpen: false,
  hintOpen: false,
  hintMinimized: false,
  // Switching Feat clears the sub-focus stack — sub-tokens belong to
  // a specific Feat and would otherwise leak into the next scope's
  // predicate (e.g. an MKT 'stock' sub-focus would mis-activate cells
  // whose scope happens to be `${feat}.stock` in another Feat).
  setActive: (f) => set({ activeFeat: f, subFocus: [] }),
  setFullscreen: (f) => set({ fullscreen: f }),
  toggleFullscreen: (f) =>
    set((s) => ({ fullscreen: s.fullscreen === f ? null : f })),
  pushSubFocus: (tag) => set((s) => ({ subFocus: [...s.subFocus, tag] })),
  popSubFocus: () => set((s) => ({ subFocus: s.subFocus.slice(0, -1) })),
  setModalOpen: (open) => set({ modalOpen: open }),
  setHintOpen: (open) => set({ hintOpen: open }),
  toggleHintOpen: () => set((s) => ({ hintOpen: !s.hintOpen, hintMinimized: false })),
  setHintMinimized: (min) => set({ hintMinimized: min }),
}));

/** Read the current state as a `UiCtx` (matches the shared `UiCmdCtx` shape). */
export function readUiCtx(): UiCtx {
  const s = useFocusStore.getState();
  return {
    activeFeat: s.activeFeat as string | null,
    fullscreen: s.fullscreen as string | null,
    subFocus: s.subFocus,
    modalOpen: s.modalOpen,
    hintOpen: s.hintOpen,
  };
}
