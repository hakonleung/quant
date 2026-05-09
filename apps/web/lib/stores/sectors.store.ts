/**
 * Client-side sectors store. Sectors are persisted on the backend via
 * `PUT /api/sectors` (full-replace). The store keeps an in-memory copy
 * + the transient multi-select state; `useSectorsRemoteSync` (mounted
 * once at the app shell) seeds from the backend at boot and PUTs on
 * any change.
 */

'use client';

import type { Sector, SectorKind } from '@quant/shared';
import { create } from 'zustand';

import { fetchSectors, putSectors } from '../api/sectors.js';
import { jsonEqual, useRemoteSync } from './remote-sync.js';

export type { Sector, SectorKind };

interface SectorsState {
  readonly sectors: readonly Sector[];
  setSectors(rows: readonly Sector[]): void;
  upsert(sector: Sector): void;
  remove(id: string): void;
}

export const useSectorsStore = create<SectorsState>()((set) => ({
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
}));

export function useSectorsRemoteSync(): void {
  useRemoteSync<SectorsState, readonly Sector[]>({
    store: useSectorsStore,
    load: fetchSectors,
    apply: (rows) => {
      useSectorsStore.getState().setSectors(rows);
    },
    select: (s) => s.sectors,
    equal: jsonEqual,
    save: async (rows) => {
      // Backend rewrites any client-supplied non-`s{n}` id during PUT.
      // Apply the canonical response so optimistic state (e.g.
      // `setActiveSector(tempId)`) reconciles to the assigned `s{n}`.
      const saved = await putSectors(rows);
      useSectorsStore.getState().setSectors(saved);
    },
  });
}
