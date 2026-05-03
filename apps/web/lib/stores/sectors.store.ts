/**
 * Client-side sectors store (modules/07-frontend.md §4.3, §6).
 *
 * Sectors are a "client-first" entity for the anonymous v1: CRUD lives
 * in the browser, persisted via the IndexedDB adapter
 * (`./idb-storage.ts`). The store carries both the durable definitions
 * and the transient multi-select state — only the `sectors` slice is
 * persisted.
 */

'use client';

import type { ScreenPlanAst, UniversePlanAst } from '@quant/shared';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { idbStorage } from './idb-storage.js';

export type SectorKind = 'user' | 'dynamic';

export interface Sector {
  readonly id: string;
  readonly name: string;
  readonly kind: SectorKind;
  /** Member count for user sectors; live hit count for dynamic sectors. */
  readonly count: number;
  /** Free-form metadata: themed groups for user, NL DSL for dynamic. */
  readonly meta: string;
  /** Day-over-day pct change of the basket (server-computed). */
  readonly chgPct: number | null;
  /**
   * Canonical list of 6-digit member codes. For user sectors this is
   * the persisted basket; for dynamic sectors it's the latest screen
   * hit set. Always present so `useAnalyzeMany(sector.codes)` works
   * without conditionals.
   */
  readonly codes: readonly string[];
  /**
   * For `kind === 'dynamic'`: the source NL query so the list view can
   * show / re-run it. Undefined for user sectors.
   */
  readonly nl?: string;
  /**
   * For `kind === 'dynamic'`: per-code evaluator evidence captured at
   * save time (key/value pairs surfaced as extra list columns).
   */
  readonly evidence?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Parsed screen-plan AST (for inline DSL render in the list view). */
  readonly screenPlan?: ScreenPlanAst;
  /** Parsed universe-plan AST; `null` means no universe filter. */
  readonly universePlan?: UniversePlanAst | null;
}

interface SectorsState {
  readonly sectors: readonly Sector[];
  setSectors(rows: readonly Sector[]): void;
  upsert(sector: Sector): void;
  remove(id: string): void;
}

export const useSectorsStore = create<SectorsState>()(
  persist(
    (set) => ({
      sectors: [],
      setSectors: (rows) => {
        set({ sectors: rows });
      },
      upsert: (sector) => {
        set((state) => {
          const next = state.sectors.filter((s) => s.id !== sector.id);
          return { sectors: [...next, sector] };
        });
      },
      remove: (id) => {
        set((state) => ({
          sectors: state.sectors.filter((s) => s.id !== id),
        }));
      },
    }),
    {
      name: 'sectors',
      storage: createJSONStorage(() => idbStorage('sectors')),
      partialize: (state) => ({ sectors: state.sectors }),
      version: 2,
      // v1 → v2: backfill `codes` (required for analyze_many) on
      // persisted sectors so existing IndexedDB rows keep working.
      migrate: (persistedState, version) => {
        if (version >= 2) return persistedState;
        const state = persistedState as { sectors?: readonly Partial<Sector>[] } | undefined;
        if (state === undefined) return persistedState;
        const sectors = (state.sectors ?? []).map(
          (s): Sector => ({
            id: String(s.id ?? ''),
            name: String(s.name ?? ''),
            kind: s.kind === 'dynamic' ? 'dynamic' : 'user',
            count: typeof s.count === 'number' ? s.count : 0,
            meta: String(s.meta ?? ''),
            chgPct: typeof s.chgPct === 'number' ? s.chgPct : null,
            codes: Array.isArray(s.codes) ? s.codes.map(String) : [],
          }),
        );
        return { sectors };
      },
    },
  ),
);
