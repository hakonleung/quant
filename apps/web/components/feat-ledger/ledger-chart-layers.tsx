'use client';

/**
 * Presentational SVG sub-layers for `LedgerChart`. These components
 * only render — they own no state and consume their inputs via props.
 * The orchestrating `ChartFrame` in `ledger-chart.tsx` computes the
 * geometry and hands the shapes off here.
 */

import { fonts, palette } from '../../lib/theme/tokens.js';
import { fmtAxisY } from './ledger-chart-series.js';

export const HEIGHT = 220;
export const PRICE_AXIS_W = 52;
export const DATE_AXIS_H = 18;
export const TOP_PAD = 8;
export const BOTTOM_PAD = 8;
export const PRICE_TICK_COUNT = 5;
export const PRICE_H = HEIGHT - DATE_AXIS_H;
export const INNER_TOP = TOP_PAD;
export const INNER_BOTTOM = PRICE_H - BOTTOM_PAD;
export const INNER_H = INNER_BOTTOM - INNER_TOP;

export const AXIS_TEXT_STYLE: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '9px',
};

export interface YAxisProps {
  readonly width: number;
  readonly yTicks: readonly number[];
  readonly yFor: (v: number) => number;
  readonly yMin: number;
  readonly yMax: number;
  readonly showZero: boolean;
}

export function YAxisLayer({
  width,
  yTicks,
  yFor,
  yMin,
  yMax,
  showZero,
}: YAxisProps): React.ReactElement {
  return (
    <g>
      {yTicks.map((v, i) => {
        const y = yFor(v);
        return (
          <g key={`yt-${String(i)}`}>
            <line x1={PRICE_AXIS_W - 3} x2={width} y1={y} y2={y} stroke={palette.term.line} />
            <text
              x={PRICE_AXIS_W - 6}
              y={y + 3}
              style={AXIS_TEXT_STYLE}
              fill={palette.term.ink3}
              textAnchor="end"
            >
              {fmtAxisY(v)}
            </text>
          </g>
        );
      })}
      {showZero && yMin < 0 && yMax > 0 && (
        <line x1={PRICE_AXIS_W} x2={width} y1={yFor(0)} y2={yFor(0)} stroke={palette.term.line} />
      )}
    </g>
  );
}

export interface XAxisProps {
  readonly tickKs: readonly number[];
  readonly startIdx: number;
  readonly count: number;
  readonly cxAt: (i: number) => number;
  readonly dateAt: (i: number) => string;
  readonly hoverCx: number | null;
}

export function XAxisLayer({
  tickKs,
  startIdx,
  count,
  cxAt,
  dateAt,
  hoverCx,
}: XAxisProps): React.ReactElement {
  return (
    <>
      {tickKs.map((k, ti) => {
        const i = startIdx + k;
        if (i < 0 || i >= count) return null;
        const cx = cxAt(i);
        // Hide ticks the hover label would otherwise overlap.
        if (hoverCx !== null && Math.abs(cx - hoverCx) < 24) return null;
        const isFirst = ti === 0;
        const isLast = ti === tickKs.length - 1;
        const anchor: 'start' | 'middle' | 'end' = isFirst ? 'start' : isLast ? 'end' : 'middle';
        return (
          <text
            key={`dt-${String(i)}`}
            x={cx}
            y={PRICE_H + DATE_AXIS_H - 5}
            style={AXIS_TEXT_STYLE}
            fill={palette.term.ink3}
            textAnchor={anchor}
          >
            {dateAt(i).slice(5)}
          </text>
        );
      })}
    </>
  );
}

export interface CrosshairProps {
  readonly width: number;
  readonly hoverCx: number;
  readonly hoverCy: number;
  readonly hoverDate: string;
  readonly priceAtY: number;
}

/**
 * Vertical + horizontal dashed crosshair plus the value/date labels at
 * cursor position. Y label sits inside the price-axis gutter at the
 * cursor's Y; X label sits inside the date-axis row at the bar's
 * center X (the X is bar-snapped, not free-floating).
 */
export function CrosshairLayer({
  width,
  hoverCx,
  hoverCy,
  hoverDate,
  priceAtY,
}: CrosshairProps): React.ReactElement {
  return (
    <g pointerEvents="none">
      <line
        x1={PRICE_AXIS_W + hoverCx}
        x2={PRICE_AXIS_W + hoverCx}
        y1={INNER_TOP}
        y2={INNER_BOTTOM}
        stroke={palette.light.amber}
        strokeDasharray="2 3"
        opacity={0.7}
      />
      <line
        x1={PRICE_AXIS_W}
        x2={width}
        y1={hoverCy}
        y2={hoverCy}
        stroke={palette.light.amber}
        strokeDasharray="2 3"
        opacity={0.7}
      />
      <YHoverLabel hoverCy={hoverCy} priceAtY={priceAtY} />
      <XHoverLabel width={width} hoverCx={hoverCx} hoverDate={hoverDate} />
    </g>
  );
}

function YHoverLabel({
  hoverCy,
  priceAtY,
}: {
  readonly hoverCy: number;
  readonly priceAtY: number;
}): React.ReactElement {
  return (
    <g>
      <rect
        x={2}
        y={hoverCy - 7}
        width={PRICE_AXIS_W - 4}
        height={14}
        fill={palette.light.amberBg}
        stroke={palette.light.amber}
      />
      <text
        x={PRICE_AXIS_W - 6}
        y={hoverCy + 3}
        style={AXIS_TEXT_STYLE}
        fill={palette.light.amberDark}
        textAnchor="end"
        fontWeight="700"
      >
        {fmtAxisY(priceAtY)}
      </text>
    </g>
  );
}

function XHoverLabel({
  width,
  hoverCx,
  hoverDate,
}: {
  readonly width: number;
  readonly hoverCx: number;
  readonly hoverDate: string;
}): React.ReactElement {
  const labelW = 44;
  const cxAbs = PRICE_AXIS_W + hoverCx;
  const cx = Math.max(PRICE_AXIS_W + labelW / 2, Math.min(width - labelW / 2, cxAbs));
  return (
    <g>
      <rect
        x={cx - labelW / 2}
        y={PRICE_H + 2}
        width={labelW}
        height={DATE_AXIS_H - 4}
        fill={palette.light.amberBg}
        stroke={palette.light.amber}
      />
      <text
        x={cx}
        y={PRICE_H + DATE_AXIS_H - 5}
        style={AXIS_TEXT_STYLE}
        fill={palette.light.amberDark}
        textAnchor="middle"
        fontWeight="700"
      >
        {hoverDate.slice(5)}
      </text>
    </g>
  );
}
