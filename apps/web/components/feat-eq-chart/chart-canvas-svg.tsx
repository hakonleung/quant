'use client';

/**
 * Pure-presentational SVG body for {@link ChartCanvas}.
 *
 * Receives the orchestrator's already-memoised geometry / derived
 * arrays / pointer handlers and emits the SVG tree. Splitting it out
 * keeps `chart-canvas.tsx` itself under the 400-line ceiling and
 * eliminates the >50-line / complexity-32 `ChartCanvas` function.
 *
 * No state, no refs, no useEffect — every dynamic value comes in as a
 * prop. The "internal" date-axis collision check and focus marker are
 * the only logic here, kept inline so they share the same `xForIndex`
 * / `slice` / `vp` scope without an extra hop.
 */

import type { KlineBar } from '@quant/shared';
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';

import { palette } from '../../lib/theme/tokens.js';
import type { MaKey } from '../../lib/fp/kline-chart.js';
import type { CandleGeometry } from '../../lib/fp/chart-render-helpers.js';
import type { ChartViewport } from '../../lib/fp/chart-view.js';

import { MA_COLORS, VOL_GAP } from './chart-canvas-constants.js';

const AXIS_FONT_FAMILY = 'JetBrains Mono, ui-monospace, monospace';
const AXIS_FONT_SIZE = 8;
const DATE_LABEL_W = 28;
const AXIS_TEXT_STYLE: React.CSSProperties = {
  fontFamily: AXIS_FONT_FAMILY,
  fontSize: `${String(AXIS_FONT_SIZE)}px`,
};

interface ChartSvgProps {
  readonly bars: readonly KlineBar[];
  readonly width: number;
  readonly priceH: number;
  readonly volH: number;
  readonly effVolH: number;
  readonly effVolGap: number;
  readonly priceAxisW: number;
  readonly innerW: number;
  readonly totalH: number;
  readonly vp: ChartViewport;
  readonly committedRange: { readonly start: number; readonly end: number } | null;
  readonly interactive: boolean;
  readonly showVolume: boolean;
  readonly showPriceAxis: boolean;
  readonly showDateAxis: boolean;
  readonly hoverPrice: number | null;
  readonly selectedIdx: number | null;
  readonly focusIdx: number | null;
  readonly candleGeom: readonly CandleGeometry[];
  readonly maPaths: Record<MaKey, string>;
  readonly priceTicks: readonly number[];
  readonly dateTickIdx: readonly number[];
  readonly scaleY: (price: number) => number;
  readonly xForIndex: (idx: number) => number;
  readonly dragRef: MutableRefObject<unknown>;
  readonly onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerCancel: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerLeave: (e: ReactPointerEvent<SVGSVGElement>) => void;
}

export function ChartSvg(props: ChartSvgProps): React.ReactElement {
  const {
    width,
    priceH,
    volH,
    effVolH,
    effVolGap,
    priceAxisW,
    innerW,
    totalH,
    vp,
    committedRange,
    interactive,
    showVolume,
    showPriceAxis,
    showDateAxis,
    hoverPrice,
    selectedIdx,
    focusIdx,
    candleGeom,
    maPaths,
    priceTicks,
    dateTickIdx,
    scaleY,
    xForIndex,
    dragRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    bars,
  } = props;

  return (
    <svg
      width="100%"
      height={totalH}
      style={{
        display: 'block',
        cursor: !interactive ? 'default' : dragRef.current === null ? 'crosshair' : 'grabbing',
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
        {candleGeom.map((c) => (
          <CandleGroup
            key={`c-${String(c.idx)}`}
            geom={c}
            candleW={vp.candleW}
            priceH={priceH}
            effVolH={effVolH}
            effVolGap={effVolGap}
            isFocused={focusIdx === c.idx}
          />
        ))}
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
        {showVolume &&
          candleGeom.map((c) => (
            <rect
              key={`v-${String(c.idx)}`}
              x={c.x}
              y={c.volY}
              width={vp.candleW}
              height={Math.max(1, c.volH)}
              fill={c.isUp ? palette.light.up : palette.light.down}
              opacity={focusIdx === null || focusIdx === c.idx ? 0.85 : 0.4}
            />
          ))}

        {showDateAxis && (
          <DateTicks
            bars={bars}
            dateTickIdx={dateTickIdx}
            xForIndex={xForIndex}
            candleW={vp.candleW}
            innerW={innerW}
            totalH={totalH}
            interactive={interactive}
            focusIdx={focusIdx}
          />
        )}

        {interactive && focusIdx !== null && bars[focusIdx] !== undefined && (
          <FocusDateMarker
            date={bars[focusIdx].date}
            cx={Math.max(
              18,
              Math.min(innerW - 18, xForIndex(focusIdx) + vp.candleW / 2),
            )}
            totalH={totalH}
          />
        )}
      </g>

      {interactive && hoverPrice !== null && selectedIdx === null && (
        <HoverCrosshair
          y={scaleY(hoverPrice)}
          width={width}
          priceAxisW={priceAxisW}
          price={hoverPrice}
        />
      )}
    </svg>
  );
}

interface CandleGroupProps {
  readonly geom: CandleGeometry;
  readonly candleW: number;
  readonly priceH: number;
  readonly effVolH: number;
  readonly effVolGap: number;
  readonly isFocused: boolean;
}

function CandleGroup({
  geom: c,
  candleW,
  priceH,
  effVolH,
  effVolGap,
  isFocused,
}: CandleGroupProps): React.ReactElement {
  const stroke = c.isUp ? palette.light.up : palette.light.down;
  return (
    <g>
      {isFocused && (
        <rect
          x={c.x - 1}
          y={0}
          width={candleW + 2}
          height={priceH + effVolGap + effVolH}
          fill="rgba(184,117,20,0.08)"
        />
      )}
      {c.highY < c.top && (
        <line x1={c.wickX} x2={c.wickX} y1={c.highY} y2={c.top} stroke={stroke} />
      )}
      {c.lowY > c.top + c.bodyH && (
        <line
          x1={c.wickX}
          x2={c.wickX}
          y1={c.top + c.bodyH}
          y2={c.lowY}
          stroke={stroke}
        />
      )}
      {c.isUp ? (
        <rect
          x={c.x + 0.5}
          y={c.top + 0.5}
          width={Math.max(1, candleW - 1)}
          height={Math.max(1, c.bodyH - 1)}
          fill="none"
          stroke={palette.light.up}
          strokeWidth={1}
        />
      ) : (
        <rect x={c.x} y={c.top} width={candleW} height={c.bodyH} fill={palette.light.down} />
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
}

function DateTicks({
  bars,
  dateTickIdx,
  xForIndex,
  candleW,
  innerW,
  totalH,
  interactive,
  focusIdx,
}: DateTicksProps): React.ReactElement {
  // Visible-pixel span of the focus marker — we intersect rendered
  // spans directly so anchor switching (start/end) at the edges
  // doesn't trick the collision check.
  const focusMarkerW = 36;
  const markerRectHalf = focusMarkerW / 2;
  const markerSpan: { readonly left: number; readonly right: number } | null =
    interactive && focusIdx !== null && bars[focusIdx] !== undefined
      ? (() => {
          const rawCx = xForIndex(focusIdx) + candleW / 2;
          const cx = Math.max(markerRectHalf, Math.min(innerW - markerRectHalf, rawCx));
          return { left: cx - markerRectHalf, right: cx + markerRectHalf };
        })()
      : null;
  const GAP = 3;

  return (
    <>
      {dateTickIdx.map((idx, ti) => {
        const b = bars[idx];
        if (b === undefined) return null;
        const rawX = xForIndex(idx) + candleW / 2;
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
      })}
    </>
  );
}

interface FocusDateMarkerProps {
  readonly date: string;
  readonly cx: number;
  readonly totalH: number;
}

function FocusDateMarker({ date, cx, totalH }: FocusDateMarkerProps): React.ReactElement {
  const markerW = 36;
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
}

function HoverCrosshair({ y, width, priceAxisW, price }: HoverCrosshairProps): React.ReactElement {
  return (
    <g>
      <line
        x1={0}
        x2={width}
        y1={y}
        y2={y}
        stroke={palette.light.amber}
        strokeDasharray="2 3"
        opacity="0.7"
      />
      <rect
        x={0}
        y={y - 7}
        width={priceAxisW - 2}
        height={14}
        fill={palette.light.amberBg}
        stroke={palette.light.amber}
      />
      <text
        x={priceAxisW - 6}
        y={y + 3}
        style={AXIS_TEXT_STYLE}
        fill={palette.light.amberDark}
        textAnchor="end"
        fontWeight="700"
      >
        {price.toFixed(2)}
      </text>
    </g>
  );
}
