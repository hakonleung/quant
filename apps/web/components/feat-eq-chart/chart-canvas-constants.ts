/**
 * Shared layout / colour constants for the chart canvas. Lifted into a
 * non-`'use client'` file so the orchestrator (`chart-canvas.tsx`) and
 * the presentational SVG body (`chart-canvas-svg.tsx`) can both
 * consume them without circular dependency.
 *
 * Colour values themselves no longer live here — chart code resolves
 * them at runtime via `useTokenColor` / `useTokenColors`. The four MA
 * overlays fold straight onto workbench tokens (`link` / `accent` /
 * `violet` / `down`) so the chart palette stays in lockstep with the
 * rest of the UI — see `lib/theme/THEME_DESIGN.md` §1.6. This file
 * only exposes the canonical token paths and a small helper that
 * re-maps a positional `string[]` (the order callers pass to
 * `useTokenColors`) back into the `Record<MaKey, string>` shape the
 * SVG layer wants.
 */

import type { MaKey } from '../../lib/fp/kline-chart.js';

export const PRICE_AXIS_W = 48;
export const TOP_PAD = 8;
export const BOTTOM_PAD = 8;
export const VOL_GAP = 4;
export const DATE_AXIS_H = 22;

/** Default heights — used by EQ.CHART. */
export const DEFAULT_PRICE_H = 240;
/**
 * Volume sub-pane height. Slimmed from 64 → 36 — the volume bars are
 * informational only and were dominating vertical real estate.
 */
export const DEFAULT_VOL_H = 36;

/**
 * Token paths for the 4 moving-average overlays, in
 * `[ma5, ma10, ma20, ma60]` order. Pass directly to `useTokenColors`
 * and feed the resulting `readonly string[]` through
 * {@link getMaColors} to rebuild the `Record<MaKey, string>` map.
 */
export const MA_COLOR_PATHS = ['link', 'accent', 'violet', 'down'] as const;

export function getMaColors(resolved: readonly string[]): Readonly<Record<MaKey, string>> {
  return {
    ma5: resolved[0] ?? '',
    ma10: resolved[1] ?? '',
    ma20: resolved[2] ?? '',
    ma60: resolved[3] ?? '',
  };
}
