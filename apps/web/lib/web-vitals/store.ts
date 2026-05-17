'use client';

/**
 * Module-level singleton that subscribes to web-vitals exactly once,
 * the very first time a client component mounts and triggers
 * `startWebVitals()`. Consumer components read the current snapshot
 * via `useSyncExternalStore` (see `useWebVitals`).
 *
 * Why a singleton instead of subscribing inside the hook:
 *   - `web-vitals` v4 stops collecting LCP candidates after the first
 *     user input (or page hide). If the hook is mounted lazily — e.g.
 *     only when the user opens the SYS tab — the click that mounted
 *     it already counts as first input, and `onLCP` will never fire.
 *   - CLS accumulates from registration time; subscribing late means
 *     missing every shift that happened during initial paint.
 *   - INP needs at least one interaction, but registering early at
 *     least guarantees we capture the *first* one rather than dropping
 *     it.
 *
 * `reportAllChanges: true` on LCP/CLS forces every update through
 * instead of waiting for the page to be hidden (the default), so the
 * dashboard cell reflects the live value.
 */

import { onCLS, onINP, onLCP, type Metric } from 'web-vitals';

export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface VitalSample {
  /** Raw metric value: ms for LCP/INP, unitless for CLS. */
  readonly value: number;
  readonly rating: VitalRating;
}

export interface WebVitals {
  readonly lcp: VitalSample | null;
  readonly inp: VitalSample | null;
  readonly cls: VitalSample | null;
}

const EMPTY: WebVitals = { lcp: null, inp: null, cls: null };

let snapshot: WebVitals = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function toSample(m: Metric): VitalSample {
  const rating: VitalRating =
    m.rating === 'good' || m.rating === 'needs-improvement' ? m.rating : 'poor';
  return { value: m.value, rating };
}

function update(key: keyof WebVitals, m: Metric): void {
  snapshot = { ...snapshot, [key]: toSample(m) };
  listeners.forEach((l) => l());
}

export function startWebVitals(): void {
  if (started) return;
  started = true;
  onLCP((m) => update('lcp', m), { reportAllChanges: true });
  onINP((m) => update('inp', m), { reportAllChanges: true });
  onCLS((m) => update('cls', m), { reportAllChanges: true });
}

export function subscribeWebVitals(cb: () => void): () => void {
  listeners.add(cb);
  return (): void => {
    listeners.delete(cb);
  };
}

export function getWebVitalsSnapshot(): WebVitals {
  return snapshot;
}

export function getWebVitalsServerSnapshot(): WebVitals {
  return EMPTY;
}

/** Test-only — resets module state without needing `vi.resetModules`. */
export function __resetWebVitalsForTest(): void {
  snapshot = EMPTY;
  started = false;
  listeners.clear();
}
