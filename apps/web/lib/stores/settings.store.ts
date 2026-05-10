/**
 * User settings (theme + Slack push targets + applied columns) are
 * persisted on the backend via `PUT /api/sys-cfg`. This store mirrors
 * the in-memory copy; `useSysCfgRemoteSync` (mounted once at the shell)
 * loads at boot and debounce-PUTs on change.
 *
 * The user-maintained "stock blacklist" was removed in 2026-05; the
 * A-share noise blacklist is now backend-cron-managed and reachable via
 * `/api/blacklist` (see `lib/hooks/use-blacklist.ts`).
 */

'use client';

import type { ColumnFilter, DragDirection, SlackTarget, SysCfg, ThemeMode } from '@quant/shared';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import { fetchSysCfg, putSysCfg } from '../api/sys-cfg.js';
import {
  COLUMN_KEYS,
  DEFAULT_APPLIED_COLUMNS,
  isColumnKey,
  type ColumnKey,
} from '../eqty/columns.catalog.js';
import { jsonEqual } from './remote-sync.js';

export type { ThemeMode, SlackTarget, DragDirection };

interface SettingsState {
  readonly theme: ThemeMode;
  readonly slackTargets: readonly SlackTarget[];
  /** E-1 list applied columns, in render order. */
  readonly appliedColumns: readonly ColumnKey[];
  /**
   * Per-column numeric filter (e.g. `> 5`). Only columns present here
   * participate in EQ.LIST row filtering. Rows whose column value is
   * null / undefined are skipped (no opinion).
   */
  readonly columnFilters: Readonly<Partial<Record<ColumnKey, ColumnFilter>>>;
  readonly dragDirection: DragDirection;
  setTheme(theme: ThemeMode): void;
  addSlackTarget(target: SlackTarget): void;
  removeSlackTarget(channel: string): void;
  setAppliedColumns(keys: readonly ColumnKey[]): void;
  setColumnFilter(key: ColumnKey, filter: ColumnFilter | null): void;
  setDragDirection(direction: DragDirection): void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  theme: 'light',
  slackTargets: [],
  appliedColumns: DEFAULT_APPLIED_COLUMNS,
  columnFilters: {},
  dragDirection: 'inverted',
  setTheme: (theme) => {
    set({ theme });
  },
  setDragDirection: (direction) => {
    set({ dragDirection: direction });
  },
  addSlackTarget: (target) => {
    set((state) => {
      const next = state.slackTargets.filter((t) => t.channel !== target.channel);
      return { slackTargets: [...next, target] };
    });
  },
  removeSlackTarget: (channel) => {
    set((state) => ({
      slackTargets: state.slackTargets.filter((t) => t.channel !== channel),
    }));
  },
  setAppliedColumns: (keys) => {
    const seen = new Set<ColumnKey>();
    const cleaned: ColumnKey[] = [];
    for (const k of keys) {
      if (!seen.has(k) && isColumnKey(k)) {
        seen.add(k);
        cleaned.push(k);
      }
    }
    set((state) => {
      // Drop filters for columns no longer applied (they'd be invisible
      // and confusing — re-adding the column shouldn't silently inherit
      // a stale predicate).
      const keep: Partial<Record<ColumnKey, ColumnFilter>> = {};
      const appliedSet = new Set<ColumnKey>(cleaned);
      for (const [k, v] of Object.entries(state.columnFilters)) {
        if (v === undefined) continue;
        const ck = k as ColumnKey;
        if (appliedSet.has(ck)) keep[ck] = v;
      }
      return { appliedColumns: cleaned, columnFilters: keep };
    });
  },
  setColumnFilter: (key, filter) => {
    set((state) => {
      const next: Partial<Record<ColumnKey, ColumnFilter>> = { ...state.columnFilters };
      if (filter === null) delete next[key];
      else next[key] = filter;
      return { columnFilters: next };
    });
  },
}));

function snapshotCfg(): SysCfg {
  const s = useSettingsStore.getState();
  const filters: Record<string, ColumnFilter> = {};
  for (const [k, v] of Object.entries(s.columnFilters)) {
    if (v !== undefined) filters[k] = v;
  }
  return {
    theme: s.theme,
    slackTargets: [...s.slackTargets],
    appliedColumns: [...s.appliedColumns],
    dragDirection: s.dragDirection,
    columnFilters: filters,
  };
}

function applyCfg(cfg: SysCfg): void {
  const known = new Set<string>(COLUMN_KEYS);
  const filtered: ColumnKey[] = [];
  const seen = new Set<ColumnKey>();
  for (const k of cfg.appliedColumns) {
    if (known.has(k) && isColumnKey(k) && !seen.has(k)) {
      seen.add(k);
      filtered.push(k);
    }
  }
  const appliedFinal = filtered.length === 0 ? DEFAULT_APPLIED_COLUMNS : filtered;
  const appliedSet = new Set<ColumnKey>(appliedFinal);
  const filters: Partial<Record<ColumnKey, ColumnFilter>> = {};
  for (const [k, v] of Object.entries(cfg.columnFilters)) {
    if (v === undefined) continue;
    if (!isColumnKey(k)) continue;
    if (!appliedSet.has(k)) continue;
    filters[k] = v;
  }
  useSettingsStore.setState({
    theme: cfg.theme,
    slackTargets: cfg.slackTargets,
    appliedColumns: appliedFinal,
    dragDirection: cfg.dragDirection,
    columnFilters: filters,
  });
}

const DEBOUNCE_MS = 400;

/**
 * Boot hook — call once at the app shell. Loads sys-cfg from the
 * backend and seeds the store; afterwards any mutation debounce-PUTs
 * the combined blob.
 */
export function useSysCfgRemoteSync(): void {
  const lastSentRef = useRef<SysCfg | null>(null);
  const loadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const cfg = await fetchSysCfg();
        if (cancelled) return;
        applyCfg(cfg);
        lastSentRef.current = snapshotCfg();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('sys-cfg boot fetch failed', err);
      } finally {
        loadedRef.current = true;
      }
    })();

    const onChange = (): void => {
      if (!loadedRef.current) return;
      const next = snapshotCfg();
      const last = lastSentRef.current;
      if (last !== null && jsonEqual(last, next)) return;
      lastSentRef.current = next;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        putSysCfg(next).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn('sys-cfg save failed', err);
        });
      }, DEBOUNCE_MS);
    };

    const u1 = useSettingsStore.subscribe(onChange);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      u1();
    };
  }, []);
}
