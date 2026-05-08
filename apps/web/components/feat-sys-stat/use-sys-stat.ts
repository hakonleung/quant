'use client';

/**
 * Hooks owned by SYS.STAT. Split out of `feat-sys-stat.tsx` so the
 * component file stays under the 400-line ceiling (CLAUDE.md §1.2)
 * and so the side-effecting layer is grouped together.
 */

import { ScanAcceptedSchema, type ScanAccepted, type ScanKind } from '@quant/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { formatClock } from '../../lib/fp/sys-stat-fmt.js';

export interface ManualScan {
  readonly run: () => void;
  /** True for ~1s after a successful submit; gives the button a flash. */
  readonly flashing: boolean;
  readonly last: ScanAccepted | null;
  readonly error: string | null;
}

const FLASH_MS = 1000;

export function useManualScan(kind: ScanKind): ManualScan {
  const [last, setLast] = useState<ScanAccepted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!flashing) return;
    const t = setTimeout(() => {
      setFlashing(false);
    }, FLASH_MS);
    return (): void => {
      clearTimeout(t);
    };
  }, [flashing, last]);

  const run = (): void => {
    setError(null);
    fetch(`/api/orchestration/scan?kind=${kind}`, { method: 'POST' })
      .then(async (r) => {
        const raw: unknown = await r.json();
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
        return ScanAcceptedSchema.parse(raw);
      })
      .then((res) => {
        setLast(res);
        setFlashing(true);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  };
  return { run, flashing, last, error };
}

/**
 * Single bridge from the runtime `Date` global into a typed factory so
 * callers (and tests) can swap in a frozen clock. Concentrating the
 * disable here keeps every other module pure-time per CLAUDE.md §1.2.
 */
type ClockFn = () => Date;
// eslint-disable-next-line no-restricted-globals -- only Date bridge in this file; pure formatter takes the resulting Date as input
const SYSTEM_CLOCK: ClockFn = () => new Date();

/**
 * Wall-clock string updated once per second. Initial state is empty so
 * SSR and the first client render emit the same text node — the real
 * timestamp is filled in by the first effect, after hydration. A
 * `useState(() => formatClock(now()))` initializer would have run on
 * both server and client a few ms apart and tripped React's "Text
 * content does not match server-rendered HTML" hydration check.
 */
export function useClock(now: ClockFn = SYSTEM_CLOCK): string {
  const [iso, setIso] = useState<string>('');
  useEffect(() => {
    setIso(formatClock(now()));
    const t = setInterval(() => {
      setIso(formatClock(now()));
    }, 1000);
    return (): void => {
      clearInterval(t);
    };
  }, [now]);
  return iso;
}

/**
 * FPS counter — counts requestAnimationFrame ticks per second. Updates
 * once per closed window so the readout doesn't itself thrash. Returns
 * 0 until the first window closes.
 */
export function useFps(): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (current: number): void => {
      frames += 1;
      const elapsed = current - last;
      if (elapsed >= 1000) {
        setFps(Math.round((frames * 1000) / elapsed));
        frames = 0;
        last = current;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);
  return fps;
}

interface PerformanceMemory {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
}

/**
 * Type guard for the non-standard `performance.memory` extension. Uses
 * structural narrowing (`'memory' in p`) so we don't need a banned
 * `as` assertion (`@typescript-eslint/consistent-type-assertions`).
 */
function hasPerformanceMemory(
  p: Performance,
): p is Performance & { readonly memory: PerformanceMemory } {
  if (!('memory' in p)) return false;
  const m: unknown = p.memory;
  if (typeof m !== 'object' || m === null) return false;
  if (!('usedJSHeapSize' in m)) return false;
  return typeof m.usedJSHeapSize === 'number';
}

/**
 * Used JS-heap size in MiB, polled at 1 Hz. Chromium-only; returns
 * `null` on browsers without `performance.memory`.
 */
export function useMemoryMb(): number | null {
  const [mb, setMb] = useState<number | null>(null);
  const supported = useRef(true);
  useEffect(() => {
    if (!supported.current) return;
    const sample = (): void => {
      if (!hasPerformanceMemory(performance)) {
        supported.current = false;
        setMb(null);
        return;
      }
      setMb(Math.round(performance.memory.usedJSHeapSize / (1024 * 1024)));
    };
    sample();
    const t = setInterval(sample, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);
  return mb;
}

/**
 * Edge-trigger: when the socket-reported active-scan list transitions
 * away from including 'blacklist' / 'all', the cron has just finished
 * refreshing data/blacklist.json — invalidate the client-side query so
 * the synthetic "全 A" sector picks up the new filter immediately
 * instead of waiting out the 5-minute stale window.
 */
export function useBlacklistInvalidate(isNowScanning: boolean): void {
  const qc: QueryClient = useQueryClient();
  const wasScanningRef = useRef(false);
  useEffect(() => {
    if (wasScanningRef.current && !isNowScanning) {
      void qc.invalidateQueries({ queryKey: ['blacklist'] });
    }
    wasScanningRef.current = isNowScanning;
  }, [isNowScanning, qc]);
}
