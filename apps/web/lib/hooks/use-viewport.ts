'use client';

/**
 * Single source of truth for viewport / pointer queries used by the
 * shell and per-Feat responsive branches.
 *
 * Three width modes — kept aligned with the docs/UX plan §4 table:
 *   - `mobile`  : viewport <  768px  → bottom-tab single-Feat shell
 *   - `tablet`  : 768–1279px         → two columns + drawer
 *   - `desktop` : ≥ 1280px           → current three-column workbench
 *
 * `coarsePointer` is independent: a 1024px Surface tablet with a stylus
 * still wants the 36px touch targets even though it lays out as
 * `tablet`. We therefore expose both axes and let callers pick.
 *
 * SSR safety: server render assumes `desktop` + fine pointer (the
 * dominant historical viewport). The first client effect reconciles
 * with the real `matchMedia` result. Components that change layout on
 * `mode` should accept the brief flash or render `null` until mounted.
 */

import { useSyncExternalStore } from 'react';

export type ViewportMode = 'mobile' | 'tablet' | 'desktop';

export interface ViewportSnapshot {
  readonly mode: ViewportMode;
  readonly width: number;
  readonly coarsePointer: boolean;
}

const MOBILE_MAX = 767;
const TABLET_MAX = 1279;

const SSR_SNAPSHOT: ViewportSnapshot = {
  mode: 'desktop',
  width: 1440,
  coarsePointer: false,
};

function readSnapshot(): ViewportSnapshot {
  if (typeof window === 'undefined') return SSR_SNAPSHOT;
  const width = window.innerWidth;
  const mode: ViewportMode =
    width <= MOBILE_MAX ? 'mobile' : width <= TABLET_MAX ? 'tablet' : 'desktop';
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  return { mode, width, coarsePointer };
}

let cached: ViewportSnapshot = SSR_SNAPSHOT;

function getSnapshot(): ViewportSnapshot {
  // Memoise so React's `useSyncExternalStore` snapshot equality check
  // returns the *same* reference between renders when nothing changed —
  // otherwise every render counts as an external store update and
  // forces every consumer to re-render.
  const next = readSnapshot();
  if (
    cached.mode === next.mode &&
    cached.width === next.width &&
    cached.coarsePointer === next.coarsePointer
  ) {
    return cached;
  }
  cached = next;
  return cached;
}

function getServerSnapshot(): ViewportSnapshot {
  return SSR_SNAPSHOT;
}

function subscribe(notify: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  // resize fires for both width and (on iOS) on-screen-keyboard show.
  // The pointer media-query rarely fires post-load but we still listen
  // so plugged-in mice / detached keyboards swap into fine pointer.
  const pointerMq = window.matchMedia('(pointer: coarse)');
  window.addEventListener('resize', notify);
  pointerMq.addEventListener('change', notify);
  return () => {
    window.removeEventListener('resize', notify);
    pointerMq.removeEventListener('change', notify);
  };
}

export function useViewport(): ViewportSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Convenience boolean for shell-level layout swaps. */
export function useIsMobile(): boolean {
  return useViewport().mode === 'mobile';
}
