'use client';

/**
 * Subscribes to Google Web Vitals and exposes the latest sample for
 * each Core Web Vital (LCP / INP / CLS) plus the official rating
 * bucket so the consumer can colour the readout without re-deriving
 * thresholds.
 *
 * Notes on semantics — kept faithful to web-vitals v4 to avoid
 * misleading the dashboard:
 *   - LCP fires its terminal value once per page load and does NOT
 *     re-fire on SPA route changes; the value below is therefore the
 *     first-load LCP, not the per-mode LCP.
 *   - INP and CLS keep updating as the user interacts / layout
 *     shifts, so the cells will keep changing live.
 *   - All callbacks are no-ops during SSR (web-vitals guards on
 *     `typeof window`); the hook itself only subscribes inside
 *     `useEffect`, which never runs on the server.
 */

import { useEffect, useState } from 'react';
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

function toSample(m: Metric): VitalSample {
  // web-vitals types `rating` as the union of the three buckets, but
  // the field is declared `string` historically — cast through the
  // local alias rather than `as VitalRating` to keep the boundary
  // explicit and survive a future library widening.
  const rating: VitalRating =
    m.rating === 'good' || m.rating === 'needs-improvement' ? m.rating : 'poor';
  return { value: m.value, rating };
}

export function useWebVitals(): WebVitals {
  const [v, setV] = useState<WebVitals>(EMPTY);
  useEffect(() => {
    let mounted = true;
    const apply =
      (key: keyof WebVitals) =>
      (m: Metric): void => {
        if (!mounted) return;
        setV((prev) => ({ ...prev, [key]: toSample(m) }));
      };
    onLCP(apply('lcp'));
    onINP(apply('inp'));
    onCLS(apply('cls'));
    return (): void => {
      // web-vitals exposes no unsubscribe; guard against a late
      // callback firing after unmount instead.
      mounted = false;
    };
  }, []);
  return v;
}
