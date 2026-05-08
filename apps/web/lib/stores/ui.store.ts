/**
 * UI selection state (modules/07-frontend.md §6 — "ui.store").
 *
 * `activeSectorId` and `focusCode` are persisted to IndexedDB so a
 * page reload returns the user to the same workspace cursor. The
 * transient bits — NL screen result and chart range — are not
 * persisted; they reset to a clean slate on refresh.
 */

'use client';

import type { NlScreenResult } from '@quant/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { idbStorage } from './idb-storage.js';

/** Synthetic sector id for the always-pinned "All" entry — no filter. */
export const ALL_SECTOR_ID = 'all';

/**
 * Active tab in the mobile shell. The desktop layout shows every Feat
 * concurrently, so this slice has no effect on viewports ≥ 768px — it
 * only routes the single-Feat-at-a-time mobile shell.
 */
export type MobileTab = 'list' | 'chart' | 'ai' | 'ledger' | 'watch';
export const MOBILE_TAB_DEFAULT: MobileTab = 'list';

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
  /** Currently active tab in the mobile shell. Persisted so a refresh
   *  on the phone keeps the user on the same Feat. */
  readonly mobileTab: MobileTab;
  setFocusCode(code: string | null): void;
  setActiveSector(id: string): void;
  setNlResult(result: NlScreenResult | null): void;
  setChartRange(range: ChartRangeSelection | null): void;
  /**
   * Function-property style (rather than method shorthand) so the
   * `@typescript-eslint/unbound-method` rule treats it as a plain
   * value when consumers extract it from a Zustand selector. The
   * legacy setters above predate this convention.
   */
  readonly setMobileTab: (tab: MobileTab) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      focusCode: null,
      activeSectorId: ALL_SECTOR_ID,
      nlResult: null,
      chartRange: null,
      mobileTab: MOBILE_TAB_DEFAULT,
      setFocusCode: (code) => {
        set({ focusCode: code, chartRange: null });
      },
      setActiveSector: (id) => {
        // Clear focus on sector switch so the list panel's auto-default
        // effect can pick the first member of the new sector.
        set({ activeSectorId: id, focusCode: null, chartRange: null });
      },
      setNlResult: (result) => {
        set({ nlResult: result });
      },
      setChartRange: (range) => {
        set({ chartRange: range });
      },
      setMobileTab: (tab) => {
        set({ mobileTab: tab });
      },
    }),
    {
      name: 'ui',
      // Bumped to v2 — mobileTab field added. Existing clients with v1
      // payloads keep their cursor; mobileTab falls back to the default.
      version: 2,
      storage: createJSONStorage(() => idbStorage('ui')),
      // Only the user's workspace cursor + last mobile tab are
      // persisted. NL results and chart ranges are session-scoped —
      // re-deriving them after a refresh would require replaying
      // server calls we don't have a cache for.
      partialize: (state) => ({
        activeSectorId: state.activeSectorId,
        focusCode: state.focusCode,
        mobileTab: state.mobileTab,
      }),
    },
  ),
);
