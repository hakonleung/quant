/**
 * Pure helpers for the interactive price chart's pan / zoom / hover
 * state machine. CLAUDE.md §2.5.1 — pure, no DOM, no React.
 */

import type { KlineBar } from '@quant/shared';

export interface ChartViewport {
  /** Pixel width of one candle (zoom). */
  readonly candleW: number;
  /** Gap between candles (zoom-proportional). */
  readonly gap: number;
  /** Right-edge pixel offset of the latest bar from the right of the viewport (pan). 0 = latest at right edge, > 0 = panned left. */
  readonly panPx: number;
}

export const DEFAULT_VIEWPORT: ChartViewport = {
  candleW: 8,
  gap: 2,
  panPx: 0,
};

export const MIN_CANDLE_W = 2;
export const MAX_CANDLE_W = 32;

export interface VisibleSlice {
  /** Index of the first visible bar in the source array. */
  readonly startIdx: number;
  /** Number of visible bars. */
  readonly count: number;
  /** X-pixel of the first visible candle, relative to the left edge. */
  readonly firstX: number;
  /** Stride (candleW + gap). */
  readonly stride: number;
}

export function visibleSlice(
  total: number,
  vp: ChartViewport,
  viewWidth: number,
): VisibleSlice {
  const stride = vp.candleW + vp.gap;
  if (total === 0 || stride <= 0) {
    return { startIdx: 0, count: 0, firstX: 0, stride };
  }
  // pan-corrected right edge: the latest bar's right pixel.
  // panPx > 0 means the user has dragged to see older bars, so latest
  // slides off to the *right* of the viewport (positive direction).
  const latestRightX = viewWidth + vp.panPx;
  const latestLeftX = latestRightX - vp.candleW;
  // Number of bars that fit before latest
  const fits = Math.ceil(viewWidth / stride) + 1;
  const startIdx = Math.max(0, total - fits - Math.floor(Math.max(0, vp.panPx) / stride));
  const count = Math.min(total - startIdx, fits + 1);
  // x of bar at startIdx: latestLeftX - (total - 1 - startIdx) * stride
  const firstX = latestLeftX - (total - 1 - startIdx) * stride;
  return { startIdx, count, firstX, stride };
}

/** Pick a bar index given a mouse X within the SVG, or null if none. */
export function indexAtX(
  mouseX: number,
  slice: VisibleSlice,
  total: number,
): number | null {
  if (slice.count === 0 || slice.stride <= 0) return null;
  const offset = mouseX - slice.firstX;
  const i = Math.floor(offset / slice.stride);
  const idx = slice.startIdx + i;
  if (idx < 0 || idx >= total) return null;
  return idx;
}

/** Fold of OHLC across a slice: returns inclusive [min, max] of low/high. */
export function priceBounds(
  bars: readonly KlineBar[],
  startIdx: number,
  count: number,
): { readonly min: number; readonly max: number } {
  if (count === 0 || bars.length === 0) return { min: 0, max: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const end = Math.min(startIdx + count, bars.length);
  for (let i = Math.max(0, startIdx); i < end; i += 1) {
    const b = bars[i];
    if (b === undefined) continue;
    if (b.high > max) max = b.high;
    if (b.low < min) min = b.low;
    for (const ma of [b.ma5, b.ma10, b.ma20, b.ma60]) {
      if (ma === null) continue;
      if (ma > max) max = ma;
      if (ma < min) min = ma;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  // Padding so the highest/lowest bars don't kiss the edges.
  const range = max - min || 1;
  return { min: min - range * 0.04, max: max + range * 0.04 };
}

export function clampViewport(vp: ChartViewport): ChartViewport {
  const candleW = Math.max(MIN_CANDLE_W, Math.min(MAX_CANDLE_W, vp.candleW));
  const gap = Math.max(0, Math.min(8, Math.round(candleW * 0.25)));
  const panPx = Math.max(0, vp.panPx);
  return { candleW, gap, panPx };
}
