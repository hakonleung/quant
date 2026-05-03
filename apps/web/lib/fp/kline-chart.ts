/**
 * Pure layout helpers for the kline chart panel
 * (CLAUDE.md §2.5.1 — pure functions live in `lib/fp/`).
 *
 * No DOM, no React, no IO. Inputs in → outputs out, deterministic.
 */

import type { KlineBar } from '@quant/shared';

export interface CandleLayout {
  readonly x: number;
  readonly highY: number;
  readonly lowY: number;
  readonly bodyY: number;
  readonly bodyH: number;
  readonly up: boolean;
}

export interface ChartGeometry {
  readonly viewWidth: number;
  readonly viewHeight: number;
  readonly leftPad: number;
  readonly topPad: number;
  readonly bottomPad: number;
  readonly candleWidth: number;
  readonly candleGap: number;
}

export const DEFAULT_GEOMETRY: ChartGeometry = {
  viewWidth: 1080,
  viewHeight: 300,
  leftPad: 20,
  topPad: 10,
  bottomPad: 10,
  candleWidth: 10,
  candleGap: 4,
};

interface BuiltLayout {
  readonly layout: readonly CandleLayout[];
  readonly scaleY: (price: number) => number;
}

export function buildLayout(
  bars: readonly KlineBar[],
  geometry: ChartGeometry = DEFAULT_GEOMETRY,
): BuiltLayout {
  if (bars.length === 0) {
    return { layout: [], scaleY: () => geometry.viewHeight - geometry.bottomPad };
  }
  let max = bars[0]!.high;
  let min = bars[0]!.low;
  for (const b of bars) {
    if (b.high > max) max = b.high;
    if (b.low < min) min = b.low;
  }
  const range = max - min || 1;
  const usableH = geometry.viewHeight - geometry.topPad - geometry.bottomPad;
  const scaleY = (price: number): number =>
    geometry.viewHeight - geometry.bottomPad - ((price - min) / range) * usableH;
  const stride = geometry.candleWidth + geometry.candleGap;

  const layout = bars.map((b, i): CandleLayout => {
    const top = scaleY(Math.max(b.open, b.close));
    const bot = scaleY(Math.min(b.open, b.close));
    return {
      x: geometry.leftPad + i * stride,
      highY: scaleY(b.high),
      lowY: scaleY(b.low),
      bodyY: top,
      bodyH: Math.max(2, bot - top),
      up: b.close >= b.open,
    };
  });
  return { layout, scaleY };
}

export type MaKey = 'ma5' | 'ma10' | 'ma20' | 'ma60';

export function buildMaPath(
  bars: readonly KlineBar[],
  key: MaKey,
  scaleY: (price: number) => number,
  geometry: ChartGeometry = DEFAULT_GEOMETRY,
): string | null {
  const stride = geometry.candleWidth + geometry.candleGap;
  const half = geometry.candleWidth / 2;
  const points: string[] = [];
  bars.forEach((b, i) => {
    const v = b[key];
    if (v === null) return;
    const x = geometry.leftPad + i * stride + half;
    points.push(`${points.length === 0 ? 'M' : 'L'}${String(x)},${scaleY(v).toFixed(1)}`);
  });
  return points.length === 0 ? null : points.join(' ');
}

/**
 * Pct change between a bar's close and the latest bar's close.
 * Returns `null` when the latest bar is missing or when the inputs are
 * the same bar (so the UI can suppress the `Δ` label cleanly).
 */
export function pctChangeToLatest(
  bars: readonly KlineBar[],
  index: number,
): number | null {
  const last = bars[bars.length - 1];
  const bar = bars[index];
  if (last === undefined || bar === undefined) return null;
  if (index === bars.length - 1) return null;
  if (bar.close === 0) return null;
  return ((last.close - bar.close) / bar.close) * 100;
}
