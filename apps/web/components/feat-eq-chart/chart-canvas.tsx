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

import { sparseIndices, type MaKey } from '../../lib/fp/kline-chart.js';
import {
  clampViewport,
  fitVisibleViewport,
  indexAtX,
  maxPanPx,
  priceBounds,
  visibleSlice,
  type ChartViewport,
} from '../../lib/fp/chart-view.js';
import { fonts, palette } from '../../lib/theme/tokens.js';

export const PRICE_AXIS_W = 48;
export const TOP_PAD = 8;
export const BOTTOM_PAD = 8;
export const VOL_GAP = 4;
export const DATE_AXIS_H = 22;

/**
 * Tick / label font for chart axes — uses the project's shared `mono`
 * stack so the chart matches FeatView header chrome and the rest of
 * the workbench. SVG `<text>` doesn't resolve Chakra theme tokens, so
 * we pull the literal stack from `lib/theme/tokens` directly. We pass
 * it as an inline `style.fontFamily` (rather than the legacy
 * `font-family` attribute) so the browser parses the CSS quoted-name
 * stack the same way it would for an HTML element — that keeps the
 * SVG glyphs visually identical to nearby Chakra `Text` chrome.
 */
const AXIS_FONT_FAMILY = fonts.mono;
/** Smaller than 9 — keeps tight vertical spacing for the slim axes. */
const AXIS_FONT_SIZE = 8;
/**
 * Approximate width (px) of a "MM-DD" date label at
 * {@link AXIS_FONT_SIZE} in the project mono stack. Used by the
 * date-tick edge-anchor logic so adjacent ticks never collide near
 * the chart boundaries.
 */
const DATE_LABEL_W = 28;
/** Pre-computed reusable axis-text style — keeps render hot-path tidy. */
const AXIS_TEXT_STYLE: React.CSSProperties = {
  fontFamily: AXIS_FONT_FAMILY,
  fontSize: `${String(AXIS_FONT_SIZE)}px`,
};

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

/** Euclidean distance between two pointer positions. Module-level so
 *  the hot-path doesn't reallocate it on every move. */
function pointerDistance(
  a: { readonly clientX: number; readonly clientY: number },
  b: { readonly clientX: number; readonly clientY: number },
): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
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

  const dragRef = useRef<{
    startClientX: number;
    startPan: number;
    moved: boolean;
  } | null>(null);
  // Active pointers (mouse / pen / touch). The map lets us spot the
  // moment a second finger lands and pivot the gesture from "pan" to
  // "pinch-zoom". Cleared on pointerup / pointercancel.
  const pointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(new Map());
  const pinchRef = useRef<{
    startDist: number;
    startCandleW: number;
    /** Bar index under the pinch midpoint when the gesture began —
     *  we keep that bar pinned to its original screen X so the user
     *  zooms *into* whatever they're holding. */
    anchorIdx: number | null;
    anchorScreenX: number;
  } | null>(null);

  // Drag-pan via window listeners is no longer required — pointer
  // capture (set in onPointerDown) keeps move/up events firing on the
  // SVG even after the finger leaves the chart bounds.

  // Auto-fit candleW so ~`DEFAULT_VISIBLE_BARS` show on first paint.
  // Triggered once per (series, width-becomes-known) tuple — refusing
  // to refit on width changes alone preserves any user-initiated
  // zoom. The series identity uses first/last dates so reordering
  // within the same range doesn't refit.
  const seriesKey =
    bars.length === 0 ? '' : `${bars[0]!.date}-${bars[bars.length - 1]!.date}`;
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

  /**
   * Pointer events unify mouse / pen / touch. Single-pointer drag
   * pans (existing behaviour); two-pointer drag pinches to adjust
   * `candleW`. Touch interactions never paint a hover crosshair —
   * touch has no hover semantics and the persistent crosshair would
   * just look like a stuck artifact after a tap.
   */
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    // setPointerCapture keeps move/up events firing on the SVG even
    // when the pointer leaves its bounds — replaces the previous
    // window-level mouse listeners.
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pointersRef.current.size === 2) {
      // Pivot single-pointer drag → pinch.
      dragRef.current = null;
      const [a, b] = [...pointersRef.current.values()];
      if (a !== undefined && b !== undefined) {
        const startDist = pointerDistance(a, b);
        if (startDist > 0) {
          const rect = e.currentTarget.getBoundingClientRect();
          const midX = (a.clientX + b.clientX) / 2 - rect.left - priceAxisW;
          const anchorIdx = indexAtX(midX, slice, bars.length);
          pinchRef.current = {
            startDist,
            startCandleW: vp.candleW,
            anchorIdx,
            anchorScreenX: midX,
          };
        }
      }
      return;
    }
    if (pointersRef.current.size > 2) return; // ignore extra fingers

    // Single-pointer = drag-pan. Same gesture for mouse and one-finger
    // touch; the existing pan logic was already pointer-agnostic.
    dragRef.current = {
      startClientX: e.clientX,
      startPan: vp.panPx,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    const rec = pointersRef.current.get(e.pointerId);
    if (rec !== undefined) {
      pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    }

    const pinch = pinchRef.current;
    if (pinch !== null && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (a === undefined || b === undefined) return;
      const dist = pointerDistance(a, b);
      if (dist <= 0) return;
      const ratio = dist / pinch.startDist;
      const nextCandleW = pinch.startCandleW * ratio;
      const nextVp = clampViewport({ ...vp, candleW: nextCandleW });
      // Anchor: keep the bar under the original midpoint at the same
      // screen X by adjusting panPx — without this, pinching would
      // always zoom around the right edge (latest bar) and the user
      // would lose whatever they pinched.
      if (pinch.anchorIdx !== null) {
        const stride = nextVp.candleW + nextVp.gap;
        const totalSpan = bars.length * stride - nextVp.gap;
        const upper = Math.max(0, totalSpan - innerW);
        const desiredFirstX =
          pinch.anchorScreenX - (pinch.anchorIdx - 0) * stride;
        const desiredLatestRightX = desiredFirstX + bars.length * stride - nextVp.gap;
        const nextPan = Math.min(upper, Math.max(0, desiredLatestRightX - innerW));
        setVp({ ...nextVp, panPx: nextPan });
      } else {
        setVp(nextVp);
      }
      return;
    }

    const drag = dragRef.current;
    if (drag !== null) {
      const dx = e.clientX - drag.startClientX;
      if (Math.abs(dx) > 2) drag.moved = true;
      const upper = maxPanPx(bars.length, vp, innerW);
      const nextPan = Math.min(upper, Math.max(0, drag.startPan + dx));
      setVp(clampViewport({ ...vp, panPx: nextPan }));
      return;
    }

    // Hover crosshair — mouse / pen only. Touch never produces a
    // "hover" without a contact, so suppressing this branch on touch
    // avoids leaving a stuck crosshair after a tap.
    if (e.pointerType === 'touch') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - priceAxisW;
    const y = e.clientY - rect.top;
    if (x >= 0 && y >= 0 && y <= priceH) {
      const idx = indexAtX(x, slice, bars.length);
      setHoverIdx?.(idx);
      setHoverPrice?.(inverseY(y));
    } else {
      setHoverIdx?.(null);
      setHoverPrice?.(null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    const wasPinching = pinchRef.current !== null;
    pointersRef.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer was already released */
    }

    if (pointersRef.current.size < 2) {
      pinchRef.current = null;
    }

    // After lifting one finger of a pinch, keep the remaining finger
    // active as a fresh drag — anchored to its current position so
    // there's no jump.
    if (wasPinching && pointersRef.current.size === 1) {
      const [remaining] = [...pointersRef.current.values()];
      if (remaining !== undefined) {
        dragRef.current = {
          startClientX: remaining.clientX,
          startPan: vp.panPx,
          moved: true,
        };
      }
      return;
    }

    const drag = dragRef.current;
    if (pointersRef.current.size === 0) {
      dragRef.current = null;
    }
    // Click / tap commit — only when the gesture didn't move (≤2 px).
    if (drag === null || drag.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - priceAxisW;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || y > priceH) return;
    const idx = indexAtX(x, slice, bars.length);
    if (idx === null) return;
    onBarClick?.(idx);
  };

  const onPointerCancel = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) dragRef.current = null;
  };

  const onPointerLeave = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    // Touch pointers don't have a "left the canvas" hover state.
    if (e.pointerType === 'touch') return;
    setHoverIdx?.(null);
    setHoverPrice?.(null);
  };

  // ----- pre-compute renderables -----
  const candles: React.ReactNode[] = [];
  const volBars: React.ReactNode[] = [];
  let volMax = 0;
  for (let i = slice.startIdx; i < slice.startIdx + slice.count; i += 1) {
    const b = bars[i];
    if (b === undefined) continue;
    if (b.volume > volMax) volMax = b.volume;
  }

  for (let i = slice.startIdx; i < slice.startIdx + slice.count; i += 1) {
    const b = bars[i];
    if (b === undefined) continue;
    const x = xForIndex(i);
    const up = b.close >= b.open;
    const col = up ? palette.light.up : palette.light.down;
    const top = scaleY(Math.max(b.open, b.close));
    const bot = scaleY(Math.min(b.open, b.close));
    const isFocused = focusIdx === i;
    // Chinese-market convention: 阳线 (up, red here) renders hollow —
    // body has no fill, only a coloured stroke; 阴线 (down, green)
    // renders solid. Hollow up-candles read as a clearly distinct
    // shape against solid down-candles even when colours wash out
    // (low contrast / colour-blindness).
    const bodyH = Math.max(1, bot - top);
    const wickX = x + vp.candleW / 2;
    const highY = scaleY(b.high);
    const lowY = scaleY(b.low);
    candles.push(
      <g key={`c-${String(i)}`}>
        {isFocused && (
          <rect
            x={x - 1}
            y={0}
            width={vp.candleW + 2}
            height={priceH + effVolGap + effVolH}
            fill="rgba(184,117,20,0.08)"
          />
        )}
        {/* Upper wick: from high down to body top. */}
        {highY < top && <line x1={wickX} x2={wickX} y1={highY} y2={top} stroke={col} />}
        {/* Lower wick: from body bottom down to low. Drawing two
            segments rather than a single high→low wick avoids the
            wick line crossing the inside of a hollow up-candle body
            (it would otherwise read as an extra vertical line through
            the empty rectangle). */}
        {lowY > top + bodyH && (
          <line x1={wickX} x2={wickX} y1={top + bodyH} y2={lowY} stroke={col} />
        )}
        {up ? (
          <rect
            x={x + 0.5}
            y={top + 0.5}
            width={Math.max(1, vp.candleW - 1)}
            height={Math.max(1, bodyH - 1)}
            fill="none"
            stroke={col}
            strokeWidth={1}
          />
        ) : (
          <rect x={x} y={top} width={vp.candleW} height={bodyH} fill={col} />
        )}
      </g>,
    );
    if (showVolume) {
      const vh = volMax === 0 ? 0 : (b.volume / volMax) * (volH - 4);
      volBars.push(
        <rect
          key={`v-${String(i)}`}
          x={x}
          y={priceH + VOL_GAP + (volH - vh)}
          width={vp.candleW}
          height={Math.max(1, vh)}
          fill={col}
          opacity={focusIdx === null || focusIdx === i ? 0.85 : 0.4}
        />,
      );
    }
  }

  const maPaths: Record<MaKey, string> = { ma5: '', ma10: '', ma20: '', ma60: '' };
  (['ma5', 'ma10', 'ma20', 'ma60'] as const).forEach((k) => {
    let started = false;
    for (let i = slice.startIdx; i < slice.startIdx + slice.count; i += 1) {
      const b = bars[i];
      if (b === undefined) continue;
      const v = b[k];
      if (v === null) continue;
      const x = xForIndex(i) + vp.candleW / 2;
      const y = scaleY(v).toFixed(1);
      maPaths[k] += `${started ? 'L' : 'M'}${String(x.toFixed(1))},${y} `;
      started = true;
    }
  });

  const priceTickCount = 5;
  const priceTicks: number[] = [];
  for (let i = 0; i < priceTickCount; i += 1) {
    priceTicks.push(bounds.min + ((bounds.max - bounds.min) / (priceTickCount - 1)) * i);
  }

  const targetDateTicks = Math.max(2, Math.min(8, Math.round(slice.count / 12)));
  const dateTickIdx = sparseIndices(slice.count, targetDateTicks).map((k) => slice.startIdx + k);

  return (
    <Box ref={wrapRef} w="100%" h={`${String(totalH)}px`} position="relative">
      <svg
        width="100%"
        height={totalH}
        style={{
          display: 'block',
          cursor: !interactive ? 'default' : dragRef.current === null ? 'crosshair' : 'grabbing',
          // `none` blocks the browser's default touch panning / pinch-
          // to-zoom on the chart so our pointer handlers can drive
          // pan + zoom themselves. Outside this SVG the page still
          // scrolls / zooms normally.
          touchAction: interactive ? 'none' : 'auto',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
      >
        {showVolume && (
          <>
            <line x1={priceAxisW} x2={width} y1={priceH} y2={priceH} stroke={palette.light.line} />
            <line
              x1={priceAxisW}
              x2={width}
              y1={priceH + VOL_GAP + volH}
              y2={priceH + VOL_GAP + volH}
              stroke={palette.light.line}
            />
          </>
        )}

        {showPriceAxis &&
          priceTicks.map((p, i) => {
            const y = scaleY(p);
            return (
              <g key={`pt-${String(i)}`}>
                <line x1={priceAxisW - 3} x2={width} y1={y} y2={y} stroke={palette.light.line2} />
                <text
                  x={priceAxisW - 6}
                  y={y + 3}
                  style={AXIS_TEXT_STYLE}
                  fill={palette.light.ink3}
                  textAnchor="end"
                >
                  {p.toFixed(2)}
                </text>
              </g>
            );
          })}

        <g transform={`translate(${String(priceAxisW)},0)`}>
          {committedRange !== null && (
            <rect
              x={xForIndex(committedRange.start)}
              y={0}
              width={xForIndex(committedRange.end) - xForIndex(committedRange.start) + vp.candleW}
              height={priceH + VOL_GAP + volH}
              fill="rgba(30,98,200,0.06)"
              stroke="rgba(30,98,200,0.45)"
            />
          )}
          {candles}
          {(['ma60', 'ma20', 'ma10', 'ma5'] as const).map((k) =>
            maPaths[k] === '' ? null : (
              <path
                key={k}
                d={maPaths[k]}
                fill="none"
                stroke={MA_COLORS[k]}
                strokeWidth="1.1"
                opacity="0.95"
              />
            ),
          )}
          {volBars}

          {showDateAxis &&
            (() => {
              // Visible-pixel span of the focus marker. The previous
              // collision check compared raw bar positions, but with
              // anchor switching (start/end) on the edge ticks the
              // *rendered* label position diverges from the bar's raw
              // x — so a far-from-focus rightmost tick would still
              // overlap the marker visually after being anchor-end'd
              // to `innerW`. We now intersect rendered spans directly.
              const focusMarkerW = 36;
              const markerRectHalf = focusMarkerW / 2;
              const markerSpan: { readonly left: number; readonly right: number } | null =
                interactive && focusIdx !== null && bars[focusIdx] !== undefined
                  ? (() => {
                      const rawCx = xForIndex(focusIdx) + vp.candleW / 2;
                      const cx = Math.max(
                        markerRectHalf,
                        Math.min(innerW - markerRectHalf, rawCx),
                      );
                      return { left: cx - markerRectHalf, right: cx + markerRectHalf };
                    })()
                  : null;
              const GAP = 3;
              return dateTickIdx.map((idx, ti) => {
                const b = bars[idx];
                if (b === undefined) return null;
                const rawX = xForIndex(idx) + vp.candleW / 2;
                // Edge-aware anchor: leftmost tick anchors to its left
                // edge, rightmost to its right edge, the rest stay
                // centred — keeps the labels flush with the chart
                // bounds without clamping the centre into a neighbour.
                const isFirst = ti === 0;
                const isLast = ti === dateTickIdx.length - 1;
                const textAnchor: 'start' | 'middle' | 'end' = isFirst
                  ? 'start'
                  : isLast
                    ? 'end'
                    : 'middle';
                const x = isFirst
                  ? Math.max(0, rawX - DATE_LABEL_W / 2)
                  : isLast
                    ? Math.min(innerW, rawX + DATE_LABEL_W / 2)
                    : rawX;
                // Tick label's rendered horizontal span — depends on
                // anchor, NOT just on rawX.
                const tickSpan = isFirst
                  ? { left: x, right: x + DATE_LABEL_W }
                  : isLast
                    ? { left: x - DATE_LABEL_W, right: x }
                    : { left: x - DATE_LABEL_W / 2, right: x + DATE_LABEL_W / 2 };
                if (
                  markerSpan !== null &&
                  tickSpan.left < markerSpan.right + GAP &&
                  tickSpan.right > markerSpan.left - GAP
                ) {
                  return null;
                }
                return (
                  <text
                    key={`dt-${String(idx)}`}
                    x={x}
                    y={totalH - 6}
                    style={AXIS_TEXT_STYLE}
                    fill={palette.light.ink3}
                    textAnchor={textAnchor}
                  >
                    {b.date.slice(5)}
                  </text>
                );
              });
            })()}

          {/* Focus date marker — only in interactive mode. */}
          {interactive &&
            focusIdx !== null &&
            bars[focusIdx] !== undefined &&
            (() => {
              const markerW = 36;
              const rawCx = xForIndex(focusIdx) + vp.candleW / 2;
              // Pin the marker to the inner pane so the rightmost
              // bar's highlight isn't clipped at the edge.
              const cx = Math.max(markerW / 2, Math.min(innerW - markerW / 2, rawCx));
              return (
                <g>
                  <rect
                    x={cx - markerW / 2}
                    y={totalH - 16}
                    width={markerW}
                    height={13}
                    fill={palette.light.amberBg}
                    stroke={palette.light.amber}
                  />
                  <text
                    x={cx}
                    y={totalH - 7}
                    style={AXIS_TEXT_STYLE}
                    fill={palette.light.amberDark}
                    textAnchor="middle"
                    fontWeight="700"
                  >
                    {bars[focusIdx]!.date.slice(5)}
                  </text>
                </g>
              );
            })()}
        </g>

        {/* Hover crosshair — interactive only. */}
        {interactive && hoverPrice !== null && selectedIdx === null && (
          <g>
            <line
              x1={0}
              x2={width}
              y1={scaleY(hoverPrice)}
              y2={scaleY(hoverPrice)}
              stroke={palette.light.amber}
              strokeDasharray="2 3"
              opacity="0.7"
            />
            <rect
              x={0}
              y={scaleY(hoverPrice) - 7}
              width={priceAxisW - 2}
              height={14}
              fill={palette.light.amberBg}
              stroke={palette.light.amber}
            />
            <text
              x={priceAxisW - 6}
              y={scaleY(hoverPrice) + 3}
              style={AXIS_TEXT_STYLE}
              fill={palette.light.amberDark}
              textAnchor="end"
              fontWeight="700"
            >
              {hoverPrice.toFixed(2)}
            </text>
          </g>
        )}
      </svg>
    </Box>
  );
}
