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
  indexAtX,
  priceBounds,
  visibleSlice,
  type ChartViewport,
} from '../../lib/fp/chart-view.js';
import { palette } from '../../lib/theme/tokens.js';

export const PRICE_AXIS_W = 48;
export const TOP_PAD = 8;
export const BOTTOM_PAD = 8;
export const VOL_GAP = 4;
export const DATE_AXIS_H = 22;

/** Default heights — used by EQ.CHART. */
export const DEFAULT_PRICE_H = 240;
export const DEFAULT_VOL_H = 64;

export const MA_COLORS: Readonly<Record<MaKey, string>> = {
  // Smaller window -> deeper / warmer color.
  ma5: '#7a3a05',
  ma10: '#a66610',
  ma20: '#d59231',
  ma60: '#e3b975',
};

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

  // While dragging, mouse moves outside the SVG would be lost — bind
  // to the window so the gesture survives leaving the chart bounds and
  // mouse-up always lands.
  useEffect(() => {
    if (!interactive) return;
    const onWinMove = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      const dx = e.clientX - drag.startClientX;
      if (Math.abs(dx) > 2) drag.moved = true;
      const nextPan = Math.max(0, drag.startPan + dx);
      setVp(clampViewport({ ...vp, panPx: nextPan }));
    };
    const onWinUp = (): void => {
      if (dragRef.current === null) return;
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
    return () => {
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('mouseup', onWinUp);
    };
  }, [interactive, vp, setVp]);

  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    dragRef.current = {
      startClientX: e.clientX,
      startPan: vp.panPx,
      moved: false,
    };
  };
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    if (dragRef.current !== null) return;
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
  const onMouseUp = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    const drag = dragRef.current;
    if (drag !== null) dragRef.current = null;
    if (drag?.moved === true) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - priceAxisW;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || y > priceH) return;
    const idx = indexAtX(x, slice, bars.length);
    if (idx === null) return;
    onBarClick?.(idx);
  };
  const onMouseLeave = (): void => {
    if (!interactive) return;
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
        <line
          x1={x + vp.candleW / 2}
          x2={x + vp.candleW / 2}
          y1={scaleY(b.high)}
          y2={scaleY(b.low)}
          stroke={col}
        />
        <rect x={x} y={top} width={vp.candleW} height={Math.max(1, bot - top)} fill={col} />
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
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
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
                  fontSize="9"
                  fontFamily="JetBrains Mono"
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
            dateTickIdx.map((idx) => {
              const b = bars[idx];
              if (b === undefined) return null;
              const x = xForIndex(idx) + vp.candleW / 2;
              return (
                <text
                  key={`dt-${String(idx)}`}
                  x={x}
                  y={totalH - 6}
                  fontSize="9"
                  fontFamily="JetBrains Mono"
                  fill={palette.light.ink3}
                  textAnchor="middle"
                >
                  {b.date.slice(5)}
                </text>
              );
            })}

          {/* Focus date marker — only in interactive mode. */}
          {interactive &&
            focusIdx !== null &&
            bars[focusIdx] !== undefined &&
            (() => {
              const markerW = 36;
              const cx = xForIndex(focusIdx) + vp.candleW / 2;
              return (
                <g>
                  <rect
                    x={cx - markerW / 2}
                    y={totalH - 18}
                    width={markerW}
                    height={14}
                    fill={palette.light.amberBg}
                    stroke={palette.light.amber}
                  />
                  <text
                    x={cx}
                    y={totalH - 8}
                    fontSize="9"
                    fontFamily="JetBrains Mono"
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
              fontSize="9"
              fontFamily="JetBrains Mono"
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
