'use client';

/**
 * Reusable kline canvas — the SVG-rendering core extracted from
 * ``FeatEqChart`` so other panes (notably SCR.PAT) can render mini
 * charts in the same visual language without owning EQ.CHART's
 * outer chrome.
 *
 * Two modes:
 *
 *   - **Interactive** (``interactive=true``, default) — drag-pan,
 *     hover crosshair, click-to-focus / click-twice-for-range. Used
 *     by ``FeatEqChart``. Caller owns the viewport and selection
 *     state.
 *   - **Read-only** (``interactive=false``) — no event handlers, no
 *     focus marker, no hover crosshair. Used by SCR.PAT rows. Caller
 *     supplies a static viewport (e.g. ``DEFAULT_VIEWPORT``) and the
 *     highlight-only ``committedRange``.
 *
 * Heights are configurable via ``priceH``/``volH`` so the same canvas
 * can render at "full" (240/64) and "row" (56/14) sizes.
 */

import { Box } from '@chakra-ui/react';
import type { KlineBar } from '@quant/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type MaKey } from '../../lib/fp/kline-chart.js';
import {
  buildMaPath,
  computeCandleGeometry,
  dateAxisTickIndices,
  maxVolumeIn,
  priceAxisTicks,
  type CandleGeometry,
} from '../../lib/fp/chart-render-helpers.js';
import {
  clampViewport,
  fitVisibleViewport,
  maxPanPx,
  priceBounds,
  visibleSlice,
  type ChartViewport,
} from '../../lib/fp/chart-view.js';
import { useTokenColors } from '../../lib/theme/use-token-color.js';

import { ChartSvg, type ChartColors } from './chart-canvas-svg.js';
import {
  BOTTOM_PAD,
  DATE_AXIS_H,
  DEFAULT_PRICE_H,
  DEFAULT_VOL_H,
  MA_COLOR_PATHS,
  PRICE_AXIS_W,
  TOP_PAD,
  VOL_GAP,
  getMaColors,
} from './chart-canvas-constants.js';
import { useChartPointer } from './use-chart-pointer.js';

// Re-export the layout constants other modules import from here
// (preserves the public API after splitting them into a dedicated
// constants file).
export {
  BOTTOM_PAD,
  DATE_AXIS_H,
  DEFAULT_PRICE_H,
  DEFAULT_VOL_H,
  PRICE_AXIS_W,
  TOP_PAD,
  VOL_GAP,
};

/**
 * Token paths for the non-MA chart colours, batched into a single
 * `useTokenColors` call so the chart only triggers one `getComputedStyle`
 * per theme flip rather than ~12. Paths collapsed onto workbench tokens
 * in task #6: axes / grid / candles / crosshair no longer carry their
 * own chart-specific tokens (see THEME_DESIGN.md 瘦身记录). Field names
 * on {@link ChartColors} are preserved so the SVG layer stays stable.
 */
const CHART_COLOR_PATHS = [
  'line',
  'ink3',
  'ink3',
  'line',
  'up',
  'down',
  // focus column tint (`focusBg`): used to be `accentBg` (amber),
  // which bled through hollow up-candles and made the hovered bar
  // read as amber-tinted. `hover` is a neutral subtle wash that
  // signals "this column is focused" without staining the candle.
  'hover',
  // focus-range fill: was `chart.focus.range` (rgba blue @ 6%); now
  // resolves to plain `link` and the SVG applies `fillOpacity={0.06}`
  // at draw time. Avoids carrying a chart-specific token whose only
  // job was to bake an alpha.
  'link',
  'link',
  'accent',
  'accentBg',
  'accent',
] as const;

function buildChartColors(resolved: readonly string[]): ChartColors {
  const at = (i: number): string => resolved[i] ?? '';
  return {
    axisLine: at(0),
    axisTick: at(1),
    axisLabel: at(2),
    gridLine: at(3),
    candleUp: at(4),
    candleDown: at(5),
    focusBg: at(6),
    focusRange: at(7),
    focusRangeBorder: at(8),
    crosshairLine: at(9),
    crosshairLabelBg: at(10),
    crosshairLabelText: at(11),
  };
}

export function totalChartHeight(
  priceH: number,
  volH: number,
  opts: { readonly showVolume?: boolean; readonly showDateAxis?: boolean } = {},
): number {
  const showVolume = opts.showVolume ?? true;
  const showDateAxis = opts.showDateAxis ?? true;
  return priceH + (showVolume ? VOL_GAP + volH : 0) + (showDateAxis ? DATE_AXIS_H : 0);
}

export function findRangeIndices(
  bars: readonly KlineBar[],
  startDate: string,
  endDate: string,
): { readonly start: number; readonly end: number } | null {
  let s = -1;
  let e = -1;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (b === undefined) continue;
    if (b.date === startDate) s = i;
    if (b.date === endDate) e = i;
  }
  if (s < 0 || e < 0) return null;
  return { start: Math.min(s, e), end: Math.max(s, e) };
}

export interface ChartCanvasProps {
  readonly bars: readonly KlineBar[];
  readonly vp: ChartViewport;
  readonly setVp: (next: ChartViewport) => void;
  readonly committedRange: { readonly start: number; readonly end: number } | null;
  /** Default ``true`` — turn off for static "preview"-style use. */
  readonly interactive?: boolean;
  /** Inner price-pane height. Default {@link DEFAULT_PRICE_H}. */
  readonly priceH?: number;
  /** Inner volume-pane height. Default {@link DEFAULT_VOL_H}. */
  readonly volH?: number;
  /** Whether to draw the date-axis row at the bottom. Default ``true``. */
  readonly showDateAxis?: boolean;
  /** Whether to draw the price-axis labels on the left. Default ``true``. */
  readonly showPriceAxis?: boolean;
  /** Whether to draw the volume sub-pane. Default ``true``. */
  readonly showVolume?: boolean;
  /** Interactive-only: current selected bar index. */
  readonly selectedIdx?: number | null;
  readonly setHoverIdx?: (n: number | null) => void;
  readonly hoverPrice?: number | null;
  readonly setHoverPrice?: (p: number | null) => void;
  readonly focusIdx?: number | null;
  readonly onBarClick?: (idx: number) => void;
}

export function ChartCanvas({
  bars,
  vp,
  setVp,
  committedRange,
  interactive = true,
  priceH = DEFAULT_PRICE_H,
  volH = DEFAULT_VOL_H,
  showDateAxis = true,
  showPriceAxis = true,
  showVolume = true,
  selectedIdx = null,
  setHoverIdx,
  hoverPrice = null,
  setHoverPrice,
  focusIdx = null,
  onBarClick,
}: ChartCanvasProps): React.ReactElement {
  const maTokens = useTokenColors(MA_COLOR_PATHS);
  const maColors = useMemo(() => getMaColors(maTokens), [maTokens]);
  const chartTokens = useTokenColors(CHART_COLOR_PATHS);
  const chartColors = useMemo(() => buildChartColors(chartTokens), [chartTokens]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);

  const totalH = totalChartHeight(priceH, volH, { showVolume, showDateAxis });
  const effVolH = showVolume ? volH : 0;
  const effVolGap = showVolume ? VOL_GAP : 0;
  const priceAxisW = showPriceAxis ? PRICE_AXIS_W : 0;
  const innerW = Math.max(0, width - priceAxisW);
  const slice = useMemo(() => visibleSlice(bars.length, vp, innerW), [bars.length, vp, innerW]);
  const bounds = useMemo(
    () => priceBounds(bars, slice.startIdx, slice.count),
    [bars, slice.startIdx, slice.count],
  );
  const usableH = priceH - TOP_PAD - BOTTOM_PAD;
  const range = bounds.max - bounds.min || 1;
  const scaleY = useCallback(
    (price: number): number => priceH - BOTTOM_PAD - ((price - bounds.min) / range) * usableH,
    [bounds.min, range, usableH, priceH],
  );
  const inverseY = useCallback(
    (y: number): number => bounds.min + ((priceH - BOTTOM_PAD - y) / usableH) * range,
    [bounds.min, range, usableH, priceH],
  );

  const xForIndex = useCallback(
    (idx: number): number => slice.firstX + (idx - slice.startIdx) * slice.stride,
    [slice],
  );

  // Pointer / pinch state and handlers live in the dedicated hook so
  // this file stays under the 400-line ceiling. The dragRef is exposed
  // so the cursor can flip to `grabbing` while a pan is active.
  const { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, dragRef } =
    useChartPointer({
      interactive,
      bars,
      slice,
      vp,
      setVp,
      innerW,
      priceH,
      priceAxisW,
      inverseY,
      ...(setHoverIdx !== undefined ? { setHoverIdx } : {}),
      ...(setHoverPrice !== undefined ? { setHoverPrice } : {}),
      ...(onBarClick !== undefined ? { onBarClick } : {}),
    });

  // Auto-fit candleW so ~`DEFAULT_VISIBLE_BARS` show on first paint.
  // Triggered once per (series, width-becomes-known) tuple — refusing
  // to refit on width changes alone preserves any user-initiated
  // zoom. The series identity uses first/last dates so reordering
  // within the same range doesn't refit.
  const seriesKey = bars.length === 0 ? '' : `${bars[0]!.date}-${bars[bars.length - 1]!.date}`;
  const lastFitRef = useRef<{ key: string; widthKnown: boolean }>({
    key: '',
    widthKnown: false,
  });
  useEffect(() => {
    if (!interactive) return;
    if (innerW <= 0 || bars.length === 0) return;
    const last = lastFitRef.current;
    if (last.key === seriesKey && last.widthKnown) return;
    lastFitRef.current = { key: seriesKey, widthKnown: true };
    setVp(fitVisibleViewport(innerW, bars.length));
  }, [interactive, seriesKey, innerW, bars.length, setVp]);

  // Re-clamp existing panPx whenever bars / width change so a series
  // swap or column resize can't leave the viewport panned past its
  // new upper bound.
  useEffect(() => {
    if (!interactive) return;
    if (innerW <= 0 || bars.length === 0) return;
    const upper = maxPanPx(bars.length, vp, innerW);
    if (vp.panPx > upper) setVp(clampViewport({ ...vp, panPx: upper }));
  }, [interactive, vp, bars.length, innerW, setVp]);

  // ----- pre-compute renderables (all memoised) -----
  // Candle / volume geometry depends on the visible slice + viewport
  // + price scale; recomputing it on every mouse-move-driven hover
  // re-render dominated the chart's hot path. Memoising drops the
  // hover path to a near-no-op render.
  const volMax = useMemo(
    () => maxVolumeIn(bars, slice.startIdx, slice.count),
    [bars, slice.startIdx, slice.count],
  );
  const candleGeom: readonly CandleGeometry[] = useMemo(
    () =>
      computeCandleGeometry({
        bars,
        sliceStartIdx: slice.startIdx,
        sliceCount: slice.count,
        stride: slice.stride,
        firstX: slice.firstX,
        candleW: vp.candleW,
        scaleY,
        priceH,
        volH: effVolH,
        volGap: effVolGap,
        volMax,
      }),
    [bars, slice, vp.candleW, scaleY, priceH, effVolH, effVolGap, volMax],
  );
  const maPaths: Record<MaKey, string> = useMemo(
    () => ({
      ma5: buildMaPath(
        bars,
        slice.startIdx,
        slice.count,
        slice.stride,
        slice.firstX,
        vp.candleW,
        scaleY,
        'ma5',
      ),
      ma10: buildMaPath(
        bars,
        slice.startIdx,
        slice.count,
        slice.stride,
        slice.firstX,
        vp.candleW,
        scaleY,
        'ma10',
      ),
      ma20: buildMaPath(
        bars,
        slice.startIdx,
        slice.count,
        slice.stride,
        slice.firstX,
        vp.candleW,
        scaleY,
        'ma20',
      ),
      ma60: buildMaPath(
        bars,
        slice.startIdx,
        slice.count,
        slice.stride,
        slice.firstX,
        vp.candleW,
        scaleY,
        'ma60',
      ),
    }),
    [bars, slice, vp.candleW, scaleY],
  );
  const priceTicks = useMemo(() => priceAxisTicks(bounds.min, bounds.max, 5), [bounds]);
  const dateTickIdx = useMemo(
    () => dateAxisTickIndices(slice.startIdx, slice.count),
    [slice.startIdx, slice.count],
  );

  return (
    <Box ref={wrapRef} w="100%" h={`${String(totalH)}px`} position="relative">
      <ChartSvg
        bars={bars}
        width={width}
        priceH={priceH}
        volH={volH}
        effVolH={effVolH}
        effVolGap={effVolGap}
        priceAxisW={priceAxisW}
        innerW={innerW}
        totalH={totalH}
        vp={vp}
        committedRange={committedRange}
        interactive={interactive}
        showVolume={showVolume}
        showPriceAxis={showPriceAxis}
        showDateAxis={showDateAxis}
        hoverPrice={hoverPrice}
        selectedIdx={selectedIdx}
        focusIdx={focusIdx}
        candleGeom={candleGeom}
        maPaths={maPaths}
        priceTicks={priceTicks}
        dateTickIdx={dateTickIdx}
        scaleY={scaleY}
        xForIndex={xForIndex}
        dragRef={dragRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        chartColors={chartColors}
        maColors={maColors}
      />
    </Box>
  );
}
