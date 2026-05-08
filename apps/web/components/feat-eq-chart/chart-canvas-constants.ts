/**
 * Shared layout / colour constants for the chart canvas. Lifted into a
 * non-`'use client'` file so the orchestrator (`chart-canvas.tsx`) and
 * the presentational SVG body (`chart-canvas-svg.tsx`) can both
 * consume them without circular dependency.
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

export const MA_COLORS: Readonly<Record<MaKey, string>> = {
  // One distinct hue per window so overlapping lines stay legible —
  // the prior monochrome warm scale was unreadable when MA10/20/60
  // ran near each other.
  //   MA5  blue    — fast, "current" line
  //   MA10 amber   — short-term momentum
  //   MA20 magenta — medium-term, classic 月线
  //   MA60 green   — long-term, slow
  ma5: '#3b82f6',
  ma10: '#f59e0b',
  ma20: '#ec4899',
  ma60: '#10b981',
};
