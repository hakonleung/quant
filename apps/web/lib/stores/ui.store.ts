/**
 * Transient UI state (modules/07-frontend.md §6 — "ui.store"). Not
 * persisted: refreshes reset to the default view. v1 collapses the
 * docs' multi-route layout into a single page that swaps modules in
 * place; sectors / blacklist / settings live inside the EQTY workbench
 * itself, so only the two top-level views remain on the menu.
 */

'use client';

import type { NlScreenResult } from '@quant/shared';
import { create } from 'zustand';

/** Synthetic sector id for the always-pinned "All" entry — no filter. */
export const ALL_SECTOR_ID = 'all';

interface UiState {
  /** Currently focused stock code, or null when no row has been selected. */
  readonly focusCode: string | null;
  /** Active sector id; drives the middle list panel. Defaults to "All". */
  readonly activeSectorId: string;
  /**
   * Latest NL screen result (parsed AST + matches). Set by the command
   * bar after a successful `/api/screen/nl` mutation; rendered by the
   * result panel. `null` = no query has been run this session.
   */
  readonly nlResult: NlScreenResult | null;
  setFocusCode(code: string | null): void;
  setActiveSector(id: string): void;
  setNlResult(result: NlScreenResult | null): void;
}

export const useUiStore = create<UiState>((set) => ({
  focusCode: null,
  activeSectorId: ALL_SECTOR_ID,
  nlResult: null,
  setFocusCode: (code) => {
    set({ focusCode: code });
  },
  setActiveSector: (id) => {
    set({ activeSectorId: id, focusCode: null });
  },
  setNlResult: (result) => {
    set({ nlResult: result });
  },
}));
