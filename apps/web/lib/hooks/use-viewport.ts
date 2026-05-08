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
 * SSR safety: server renders assume `desktop` + fine pointer (the
 * dominant historical viewport) and **the first client render returns
 * the same snapshot** so React's hydration text-content check passes.
 * The reconcile to the real `matchMedia` result happens in the first
 * effect (post-commit), at which point a re-render flips into the
 * actual mode. Earlier the hook used `useSyncExternalStore` with a
 * different `getSnapshot` value, which produced "Text content does
 * not match server-rendered HTML" warnings on tablet / mobile widths.
 */

import { useEffect, useState } from 'react';

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

function snapshotEqual(a: ViewportSnapshot, b: ViewportSnapshot): boolean {
  return a.mode === b.mode && a.width === b.width && a.coarsePointer === b.coarsePointer;
}

export function useViewport(): ViewportSnapshot {
  const [snap, setSnap] = useState<ViewportSnapshot>(SSR_SNAPSHOT);
  useEffect(() => {
    const update = (): void => {
      setSnap((prev) => {
        const next = readSnapshot();
        return snapshotEqual(prev, next) ? prev : next;
      });
    };
    update();
    const pointerMq = window.matchMedia('(pointer: coarse)');
    window.addEventListener('resize', update);
    pointerMq.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      pointerMq.removeEventListener('change', update);
    };
  }, []);
  return snap;
}

/** Convenience boolean for shell-level layout swaps. */
export function useIsMobile(): boolean {
  return useViewport().mode === 'mobile';
}
