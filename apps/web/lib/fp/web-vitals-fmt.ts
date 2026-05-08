/**
 * Pure formatting + colour helpers for the Web Vitals readout in
 * SYS.STAT. Kept here so the React component file stays under the
 * 400-line ceiling and so these mappings are unit-testable without a
 * DOM (CLAUDE.md §2.5.1 — pure-function core asset).
 */

import type { VitalSample } from '../hooks/use-web-vitals.js';

export type VitalCode = 'LCP' | 'INP' | 'CLS';

/**
 * Map web-vitals official rating buckets onto the terminal palette so
 * the readout colours match the same semantics Chrome DevTools shows
 * (good / needs-improvement / poor). `null` means "no sample yet" —
 * INP only fires after the first interaction, LCP after first paint.
 */
export function vitalColor(s: VitalSample | null): string {
  if (s === null) return 'term.ink3';
  if (s.rating === 'good') return 'term.green';
  if (s.rating === 'needs-improvement') return 'term.amber';
  return 'term.red';
}

/**
 * Format a time-based vital sample. Sub-second renders as `Nms`
 * (integer), >=1s switches to `N.NNs` so the cell stays compact even
 * for 5-digit ms values.
 */
export function fmtMs(s: VitalSample | null): string {
  if (s === null) return '—';
  return s.value < 1000 ? `${String(Math.round(s.value))}ms` : `${(s.value / 1000).toFixed(2)}s`;
}

/** CLS is unitless and typically <1 — three decimals matches DevTools. */
export function fmtCls(s: VitalSample | null): string {
  if (s === null) return '—';
  return s.value.toFixed(3);
}

const THRESHOLDS: Readonly<Record<VitalCode, string>> = {
  LCP: 'good ≤2.5s · poor >4s',
  INP: 'good ≤200ms · poor >500ms',
  CLS: 'good ≤0.1 · poor >0.25',
};

/**
 * Tooltip body. Includes the canonical Google thresholds so a viewer
 * can decode the colour without knowing the spec by heart.
 */
export function vitalTitle(code: VitalCode, s: VitalSample | null): string {
  if (s === null) return `${code} — awaiting sample (${THRESHOLDS[code]})`;
  return `${code} ${s.rating} — ${THRESHOLDS[code]}`;
}
