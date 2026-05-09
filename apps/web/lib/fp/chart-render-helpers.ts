/**
 * Pure derivation helpers for the SVG chart canvas — extracted from
 * `chart-canvas.tsx` so the React component stays under the 400-line
 * ceiling (CLAUDE.md §1.2) and so derived geometry is unit-testable
 * without a DOM.
 *
 * Every helper is reference-stable on identical inputs, which lets the
 * caller wrap them in `useMemo` and skip recomputation on hover-only
 * re-renders.
 */

import type { KlineBar } from '@quant/shared';

import { sparseIndices, type MaKey } from './kline-chart.js';

/**
 * Linearly-spaced price axis ticks between `[min, max]`.
 *
 * `count` is the number of ticks; the result has exactly `count`
 * entries, both endpoints inclusive. When `min === max` (degenerate
 * series, e.g. a one-bar slice) the result is a flat array of the
 * single value so the axis renders without dividing-by-zero.
 */
export function priceAxisTicks(min: number, max: number, count: number): readonly number[] {
  if (count <= 1) return [min];
  if (max === min) return Array.from({ length: count }, () => min);
  const step = (max - min) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(min + step * i);
  return out;
}

/**
 * Indices into `bars` where date-axis ticks should land. Targets
 * roughly one tick per ~12 visible bars (clamped to [2, 8]) and uses
 * `sparseIndices` to spread them evenly through the slice.
 */
export function dateAxisTickIndices(sliceStartIdx: number, sliceCount: number): readonly number[] {
  const target = Math.max(2, Math.min(8, Math.round(sliceCount / 12)));
  return sparseIndices(sliceCount, target).map((k) => sliceStartIdx + k);
}

/**
 * Per-bar drawing geometry for a single visible candle. `top` / `bot`
 * are pixel y-coordinates; `wickX` is the centre-x of the wick. Up vs
 * down (`isUp`) drives the body fill / stroke convention in the
 * caller. Pre-resolving these saves recomputation when the user moves
 * the hover crosshair (which only changes hoverIdx but currently
 * forces the entire SVG to recompute geometry).
 */
export interface CandleGeometry {
  readonly idx: number;
  readonly x: number;
  readonly wickX: number;
  readonly top: number;
  readonly bot: number;
  readonly bodyH: number;
  readonly highY: number;
  readonly lowY: number;
  readonly isUp: boolean;
  readonly volH: number;
  readonly volY: number;
}

export interface CandleGeometryInput {
  readonly bars: readonly KlineBar[];
  readonly sliceStartIdx: number;
  readonly sliceCount: number;
  readonly stride: number;
  readonly firstX: number;
  readonly candleW: number;
  /** Maps a price (number) → svg y-coordinate. Caller-supplied so we
   *  don't duplicate the `priceH/BOTTOM_PAD/...` constants here. */
  readonly scaleY: (price: number) => number;
  readonly priceH: number;
  readonly volH: number;
  readonly volGap: number;
  readonly volMax: number;
}

export function computeCandleGeometry(input: CandleGeometryInput): readonly CandleGeometry[] {
  const out: CandleGeometry[] = [];
  for (let i = input.sliceStartIdx; i < input.sliceStartIdx + input.sliceCount; i += 1) {
    const b = input.bars[i];
    if (b === undefined) continue;
    const x = input.firstX + (i - input.sliceStartIdx) * input.stride;
    const isUp = b.close >= b.open;
    const top = input.scaleY(Math.max(b.open, b.close));
    const bot = input.scaleY(Math.min(b.open, b.close));
    const bodyH = Math.max(1, bot - top);
    const wickX = x + input.candleW / 2;
    const highY = input.scaleY(b.high);
    const lowY = input.scaleY(b.low);
    const vh = input.volMax === 0 ? 0 : (b.volume / input.volMax) * (input.volH - 4);
    const volY = input.priceH + input.volGap + (input.volH - vh);
    out.push({ idx: i, x, wickX, top, bot, bodyH, highY, lowY, isUp, volH: vh, volY });
  }
  return out;
}

/**
 * Build the SVG path `d` attribute for one moving-average line over
 * the visible slice. Returns an empty string when no MA values are
 * available (early bars on a fresh series).
 */
export function buildMaPath(
  bars: readonly KlineBar[],
  sliceStartIdx: number,
  sliceCount: number,
  stride: number,
  firstX: number,
  candleW: number,
  scaleY: (price: number) => number,
  key: MaKey,
): string {
  let path = '';
  let started = false;
  for (let i = sliceStartIdx; i < sliceStartIdx + sliceCount; i += 1) {
    const b = bars[i];
    if (b === undefined) continue;
    const v = b[key];
    if (v === null) continue;
    const x = firstX + (i - sliceStartIdx) * stride + candleW / 2;
    const y = scaleY(v);
    path += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    started = true;
  }
  return path;
}

/**
 * Maximum volume across the visible slice — used to scale the volume
 * sub-pane bars. Returns 0 for an empty slice (degenerates to flat
 * bars in `computeCandleGeometry`).
 */
export function maxVolumeIn(
  bars: readonly KlineBar[],
  sliceStartIdx: number,
  sliceCount: number,
): number {
  let max = 0;
  for (let i = sliceStartIdx; i < sliceStartIdx + sliceCount; i += 1) {
    const b = bars[i];
    if (b !== undefined && b.volume > max) max = b.volume;
  }
  return max;
}
