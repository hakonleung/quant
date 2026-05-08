'use client';

/**
 * Pure-presentational SVG body for {@link ChartCanvas}.
 *
 * Receives the orchestrator's already-memoised geometry / derived
 * arrays / pointer handlers and emits the SVG tree. Splitting it out
 * keeps `chart-canvas.tsx` itself under the 400-line ceiling and
 * eliminates the >50-line / complexity-32 `ChartCanvas` function.
 *
 * Leaf SVG sub-pieces (candle, date ticks, focus marker, hover
 * crosshair) live in `chart-svg-pieces.tsx`; this file is just the
 * top-level layout glue.
 */

import type { KlineBar } from '@quant/shared';
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';

import { palette } from '../../lib/theme/tokens.js';
import type { MaKey } from '../../lib/fp/kline-chart.js';
import type { CandleGeometry } from '../../lib/fp/chart-render-helpers.js';
import type { ChartViewport } from '../../lib/fp/chart-view.js';

import { MA_COLORS, VOL_GAP } from './chart-canvas-constants.js';
import {
  CandleGroup,
  DateTicks,
  FocusDateMarker,
  HoverCrosshair,
} from './chart-svg-pieces.js';
import { AXIS_TEXT_STYLE } from './chart-svg-style.js';

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
            cx={Math.max(18, Math.min(innerW - 18, xForIndex(focusIdx) + vp.candleW / 2))}
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
