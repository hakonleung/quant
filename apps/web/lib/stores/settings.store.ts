/**
 * User settings (theme + Slack push targets + applied columns) and the
 * stock blacklist are bundled into one Sys.Cfg blob persisted on the
 * backend via `PUT /api/sys-cfg`. The two Zustand stores stay separate
 * for callers (settings vs. blacklist domains are independent) but
 * `useSysCfgRemoteSync` reads from / writes to both as one record.
 */

'use client';

import type { SlackTarget, SysCfg, ThemeMode } from '@quant/shared';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

import { fetchSysCfg, putSysCfg } from '../api/sys-cfg.js';
import {
  COLUMN_KEYS,
  DEFAULT_APPLIED_COLUMNS,
  isColumnKey,
  type ColumnKey,
} from '../eqty/columns.catalog.js';
import { useBlacklistStore } from './blacklist.store.js';
import { jsonEqual } from './remote-sync.js';

export type { ThemeMode, SlackTarget };

interface SettingsState {
  readonly theme: ThemeMode;
  readonly slackTargets: readonly SlackTarget[];
  /** E-1 list applied columns, in render order. */
  readonly appliedColumns: readonly ColumnKey[];
  setTheme(theme: ThemeMode): void;
  addSlackTarget(target: SlackTarget): void;
  removeSlackTarget(channel: string): void;
  setAppliedColumns(keys: readonly ColumnKey[]): void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  theme: 'light',
  slackTargets: [],
  appliedColumns: DEFAULT_APPLIED_COLUMNS,
  setTheme: (theme) => {
    set({ theme });
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
    set({ appliedColumns: cleaned });
  },
}));

function snapshotCfg(): SysCfg {
  const s = useSettingsStore.getState();
  const b = useBlacklistStore.getState();
  return {
    theme: s.theme,
    slackTargets: [...s.slackTargets],
    appliedColumns: [...s.appliedColumns],
    blacklist: [...b.entries],
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
  useSettingsStore.setState({
    theme: cfg.theme,
    slackTargets: cfg.slackTargets,
    appliedColumns: filtered.length === 0 ? DEFAULT_APPLIED_COLUMNS : filtered,
  });
  useBlacklistStore.getState().setEntries(cfg.blacklist);
}

const DEBOUNCE_MS = 400;

/**
 * Boot hook — call once at the app shell. Loads sys-cfg from the
 * backend and seeds both stores; afterwards any mutation in either
 * store debounce-PUTs the combined blob.
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
    const u2 = useBlacklistStore.subscribe(onChange);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      u1();
      u2();
    };
  }, []);
}
