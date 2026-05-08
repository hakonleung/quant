'use client';

/**
 * Command-palette open / query state. Kept tiny — the palette is a
 * single transient surface, not a persisted preference.
 *
 * The palette opens via the global ⌘K / Ctrl+K listener installed in
 * `AppShell`, or by clicking the SEARCH chip in `TopBar`. Closing it
 * resets `query` so the next open starts on a clean filter.
 */

import { create } from 'zustand';

interface CmdPaletteState {
  readonly open: boolean;
  readonly query: string;
  readonly setOpen: (open: boolean) => void;
  readonly setQuery: (q: string) => void;
  readonly toggle: () => void;
}

export const useCmdPaletteStore = create<CmdPaletteState>((set) => ({
  open: false,
  query: '',
  setOpen: (open) => {
    set(open ? { open: true } : { open: false, query: '' });
  },
  setQuery: (q) => {
    set({ query: q });
  },
  toggle: () => {
    set((s) => (s.open ? { open: false, query: '' } : { open: true }));
  },
}));
