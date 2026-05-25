/**
 * Runtime resolution of Chakra semantic tokens to their current CSS
 * value. Used by SVG / Canvas code that can't take a Chakra `color`
 * prop and needs an actual hex / rgba string.
 *
 * The hook subscribes to `useSettingsStore` so it re-reads the
 * computed style every time the user flips themes — but it does NOT
 * tick on every React render, because `useSyncExternalStore` only
 * notifies subscribers when the store fires `setState`.
 *
 * SSR-safe: `getServerSnapshot` returns an empty string. Callers
 * that need a non-empty fallback during SSR can `||` the result.
 *
 * Banned outside this module: direct `getComputedStyle` reads of
 * `--chakra-colors-*`. Funnel through here so theme switching
 * stays consistent.
 */

'use client';

import { useSyncExternalStore } from 'react';

import { useSettingsStore } from '../stores/settings.store.js';

/**
 * `dist.stat.mean` → `--chakra-colors-dist-stat-mean`.
 * Chakra v3 lowercases the segments and joins with `-`.
 */
function tokenPathToCssVar(path: string): string {
  return `--chakra-colors-${path.replace(/\./g, '-')}`;
}

function readVar(name: string): string {
  if (typeof document === 'undefined') return '';
  const root = document.documentElement;
  // `getPropertyValue` returns a leading-space prefix for some
  // browsers; `.trim()` makes the output suitable for direct use in
  // canvas / svg attributes.
  return getComputedStyle(root).getPropertyValue(name).trim();
}

// One subscribe shared by every hook call — keeps the React 18
// `useSyncExternalStore` identity stable so it doesn't reinit on
// parent re-renders. The store doesn't use `subscribeWithSelector`,
// so we get every state change and gate on `theme` ourselves.
function subscribeTheme(onStoreChange: () => void): () => void {
  let prevTheme = useSettingsStore.getState().theme;
  return useSettingsStore.subscribe((state) => {
    if (state.theme !== prevTheme) {
      prevTheme = state.theme;
      onStoreChange();
    }
  });
}

export function useTokenColor(tokenPath: string): string {
  const cssVar = tokenPathToCssVar(tokenPath);
  return useSyncExternalStore(
    subscribeTheme,
    () => readVar(cssVar),
    () => '',
  );
}

export function useTokenColors(paths: readonly string[]): readonly string[] {
  // Single `getComputedStyle` per snapshot — calling N hooks on a
  // chart frame would do N style-recalcs. Batching is the whole
  // point of this overload.
  //
  // The snapshot must be referentially stable when nothing has
  // changed, otherwise `useSyncExternalStore` will throw. We cache
  // the last-resolved array keyed on the joined CSS-var string.
  const cssVars = paths.map(tokenPathToCssVar);
  const key = cssVars.join('|');
  return useSyncExternalStore(
    subscribeTheme,
    () => snapshotBatch(key, cssVars),
    () => EMPTY_STRING_TUPLE,
  );
}

const EMPTY_STRING_TUPLE: readonly string[] = Object.freeze([]);

// Cache of `key → resolved string[]`. We rebuild on theme flip
// (subscribe triggers a re-render → snapshot re-runs and the cached
// entry is overwritten with fresh values). The cache is keyed on the
// full join of CSS-var names so different call sites stay isolated.
const batchCache = new Map<string, readonly string[]>();
// Track the last theme we resolved against so we can bust the cache
// when the user flips it; the `subscribeTheme` callback already
// notifies React, but the snapshot has to return a NEW array so
// `useSyncExternalStore` knows to commit.
let lastResolvedTheme: string | null = null;

function snapshotBatch(key: string, cssVars: readonly string[]): readonly string[] {
  if (typeof document === 'undefined') return EMPTY_STRING_TUPLE;
  const currentTheme = document.documentElement.dataset['theme'] ?? '';
  if (currentTheme !== lastResolvedTheme) {
    batchCache.clear();
    lastResolvedTheme = currentTheme;
  }
  const cached = batchCache.get(key);
  if (cached !== undefined) return cached;
  const style = getComputedStyle(document.documentElement);
  const resolved = Object.freeze(cssVars.map((v) => style.getPropertyValue(v).trim()));
  batchCache.set(key, resolved);
  return resolved;
}
