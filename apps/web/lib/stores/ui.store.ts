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

export type ModuleId = 'eqty' | 'stocks';

interface UiState {
  readonly view: ModuleId;
  readonly focusCode: string;
  /**
   * Latest NL screen result (parsed AST + matches). Set by the command
   * bar after a successful `/api/screen/nl` mutation; rendered by the
   * result panel. `null` = no query has been run this session.
   */
  readonly nlResult: NlScreenResult | null;
  setView(view: ModuleId): void;
  setFocusCode(code: string): void;
  setNlResult(result: NlScreenResult | null): void;
}

export const useUiStore = create<UiState>((set) => ({
  view: 'eqty',
  focusCode: '600519',
  nlResult: null,
  setView: (view) => {
    set({ view });
  },
  setFocusCode: (code) => {
    set({ focusCode: code });
  },
  setNlResult: (result) => {
    set({ nlResult: result });
  },
}));
