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

/**
 * Active reference range selected on the price chart, used by Feat 105
 * pattern-match. Cleared when the focused stock changes.
 */
export interface ChartRangeSelection {
  readonly code: string;
  readonly startDate: string;
  readonly endDate: string;
}

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
  /** Pattern-match reference range; null = not selected. */
  readonly chartRange: ChartRangeSelection | null;
  setFocusCode(code: string | null): void;
  setActiveSector(id: string): void;
  setNlResult(result: NlScreenResult | null): void;
  setChartRange(range: ChartRangeSelection | null): void;
}

export const useUiStore = create<UiState>((set) => ({
  focusCode: null,
  activeSectorId: ALL_SECTOR_ID,
  nlResult: null,
  chartRange: null,
  setFocusCode: (code) => {
    set({ focusCode: code, chartRange: null });
  },
  setActiveSector: (id) => {
    set({ activeSectorId: id, focusCode: null, chartRange: null });
  },
  setNlResult: (result) => {
    set({ nlResult: result });
  },
  setChartRange: (range) => {
    set({ chartRange: range });
  },
}));
