'use client';

/**
 * Leaf SVG sub-components for {@link ChartSvg}: candle group, date
 * ticks (with focus-marker collision avoidance), focus date marker,
 * hover crosshair. Split into a sibling file so `chart-canvas-svg.tsx`
 * fits under the 400-line ceiling.
 *
 * Each piece is purely presentational — props in, JSX out — and shares
 * the axis-text style with the parent module via a small re-export.
 *
 * Theme-aware colours arrive via `chartColors` from the parent so
 * subscriptions to `useSettingsStore` stay funnelled through one site.
 */

import type { KlineBar } from '@quant/shared';

import type { CandleGeometry } from '../../lib/fp/chart-render-helpers.js';

import type { ChartColors } from './chart-canvas-svg.js';
import { AXIS_TEXT_STYLE, DATE_LABEL_W } from './chart-svg-style.js';

interface CandleGroupProps {
  readonly geom: CandleGeometry;
  readonly candleW: number;
  readonly priceH: number;
  readonly effVolH: number;
  readonly effVolGap: number;
  readonly isFocused: boolean;
  readonly chartColors: ChartColors;
}

export function CandleGroup({
  geom: c,
  candleW,
  priceH,
  effVolH,
  effVolGap,
  isFocused,
  chartColors,
}: CandleGroupProps): React.ReactElement {
  const stroke = c.isUp ? chartColors.candleUp : chartColors.candleDown;
  return (
    <g>
      {isFocused && (
        <rect
          x={c.x - 1}
          y={0}
          width={candleW + 2}
          height={priceH + effVolGap + effVolH}
          fill={chartColors.focusBg}
        />
      )}
      {c.highY < c.top && (
        <line x1={c.wickX} x2={c.wickX} y1={c.highY} y2={c.top} stroke={stroke} />
      )}
      {c.lowY > c.top + c.bodyH && (
        <line x1={c.wickX} x2={c.wickX} y1={c.top + c.bodyH} y2={c.lowY} stroke={stroke} />
      )}
      {c.isUp ? (
        <rect
          x={c.x + 0.5}
          y={c.top + 0.5}
          width={Math.max(1, candleW - 1)}
          height={Math.max(1, c.bodyH - 1)}
          fill="none"
          stroke={chartColors.candleUp}
          strokeWidth={1}
        />
      ) : (
        <rect x={c.x} y={c.top} width={candleW} height={c.bodyH} fill={chartColors.candleDown} />
      )}
    </g>
  );
}

interface DateTicksProps {
  readonly bars: readonly KlineBar[];
  readonly dateTickIdx: readonly number[];
  readonly xForIndex: (idx: number) => number;
  readonly candleW: number;
  readonly innerW: number;
  readonly totalH: number;
  readonly interactive: boolean;
  readonly focusIdx: number | null;
  readonly chartColors: ChartColors;
}

interface TickPlacement {
  readonly anchor: 'start' | 'middle' | 'end';
  readonly x: number;
  readonly span: { readonly left: number; readonly right: number };
}

function placeDateTick(ti: number, total: number, rawX: number, innerW: number): TickPlacement {
  const isFirst = ti === 0;
  const isLast = ti === total - 1;
  const anchor: 'start' | 'middle' | 'end' = isFirst ? 'start' : isLast ? 'end' : 'middle';
  const x = isFirst
    ? Math.max(0, rawX - DATE_LABEL_W / 2)
    : isLast
      ? Math.min(innerW, rawX + DATE_LABEL_W / 2)
      : rawX;
  const span = isFirst
    ? { left: x, right: x + DATE_LABEL_W }
    : isLast
      ? { left: x - DATE_LABEL_W, right: x }
      : { left: x - DATE_LABEL_W / 2, right: x + DATE_LABEL_W / 2 };
  return { anchor, x, span };
}

function focusMarkerSpan(
  bars: readonly KlineBar[],
  focusIdx: number | null,
  interactive: boolean,
  xForIndex: (idx: number) => number,
  candleW: number,
  innerW: number,
): { readonly left: number; readonly right: number } | null {
  if (!interactive || focusIdx === null || bars[focusIdx] === undefined) return null;
  const focusMarkerW = 36;
  const half = focusMarkerW / 2;
  const rawCx = xForIndex(focusIdx) + candleW / 2;
  const cx = Math.max(half, Math.min(innerW - half, rawCx));
  return { left: cx - half, right: cx + half };
}

export function DateTicks({
  bars,
  dateTickIdx,
  xForIndex,
  candleW,
  innerW,
  totalH,
  interactive,
  focusIdx,
  chartColors,
}: DateTicksProps): React.ReactElement {
  // Visible-pixel span of the focus marker — we intersect rendered
  // spans directly so anchor switching (start/end) at the edges
  // doesn't trick the collision check.
  const markerSpan = focusMarkerSpan(bars, focusIdx, interactive, xForIndex, candleW, innerW);
  const GAP = 3;

  return (
    <>
      {dateTickIdx.map((idx, ti) => {
        const b = bars[idx];
        if (b === undefined) return null;
        const rawX = xForIndex(idx) + candleW / 2;
        const placement = placeDateTick(ti, dateTickIdx.length, rawX, innerW);
        if (
          markerSpan !== null &&
          placement.span.left < markerSpan.right + GAP &&
          placement.span.right > markerSpan.left - GAP
        ) {
          return null;
        }
        return (
          <text
            key={`dt-${String(idx)}`}
            x={placement.x}
            y={totalH - 6}
            style={AXIS_TEXT_STYLE}
            fill={chartColors.axisLabel}
            textAnchor={placement.anchor}
          >
            {b.date.slice(5)}
          </text>
        );
      })}
    </>
  );
}

interface FocusDateMarkerProps {
  readonly date: string;
  readonly cx: number;
  readonly totalH: number;
  readonly chartColors: ChartColors;
}

export function FocusDateMarker({
  date,
  cx,
  totalH,
  chartColors,
}: FocusDateMarkerProps): React.ReactElement {
  const markerW = 36;
  return (
    <g>
      <rect
        x={cx - markerW / 2}
        y={totalH - 16}
        width={markerW}
        height={13}
        fill={chartColors.crosshairLabelBg}
        stroke={chartColors.crosshairLine}
      />
      <text
        x={cx}
        y={totalH - 7}
        style={AXIS_TEXT_STYLE}
        fill={chartColors.crosshairLabelText}
        textAnchor="middle"
        fontWeight="700"
      >
        {date.slice(5)}
      </text>
    </g>
  );
}

interface HoverCrosshairProps {
  readonly y: number;
  readonly width: number;
  readonly priceAxisW: number;
  readonly price: number;
  readonly chartColors: ChartColors;
}

export function HoverCrosshair({
  y,
  width,
  priceAxisW,
  price,
  chartColors,
}: HoverCrosshairProps): React.ReactElement {
  return (
    <g>
      <line
        x1={0}
        x2={width}
        y1={y}
        y2={y}
        stroke={chartColors.crosshairLine}
        strokeDasharray="2 3"
        opacity="0.7"
      />
      <rect
        x={0}
        y={y - 7}
        width={priceAxisW - 2}
        height={14}
        fill={chartColors.crosshairLabelBg}
        stroke={chartColors.crosshairLine}
      />
      <text
        x={priceAxisW - 6}
        y={y + 3}
        style={AXIS_TEXT_STYLE}
        fill={chartColors.crosshairLabelText}
        textAnchor="end"
        fontWeight="700"
      >
        {price.toFixed(2)}
      </text>
    </g>
  );
}
