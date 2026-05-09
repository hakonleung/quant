'use client';

/**
 * Minimal SVG chart for the ledger pane.
 *
 * Two modes:
 *   - `daily`      — bar chart of daily PnL (anchor row excluded). 涨红跌绿:
 *     positive PnL → `up` token (red), negative → `down` token (green).
 *   - `cumulative` — K-line candle per non-anchor day, where
 *     open = previous derivedClosing, close = today's derivedClosing.
 *     Wicks omitted (we only have end-of-day snapshots). Body color
 *     follows the same 涨红跌绿 rule.
 *
 * Both modes share one frame: ResizeObserver-tracked pixel width, a
 * left price axis, a bottom date axis, wheel-zoom + drag-pan via the
 * shared `ChartViewport` helpers, and a crosshair driven purely by
 * pointer X (no need to land on a 2-px-wide bar).
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { EnrichedLedgerEntry } from '@quant/shared';
import { useCallback, useMemo } from 'react';

import { type VisibleSlice, visibleSlice } from '../../lib/fp/chart-view.js';
import { priceTicks, sparseIndices } from '../../lib/fp/kline-chart.js';
import {
  CrosshairLayer,
  HEIGHT,
  INNER_BOTTOM,
  INNER_H,
  PRICE_AXIS_W,
  PRICE_TICK_COUNT,
  XAxisLayer,
  YAxisLayer,
} from './ledger-chart-layers.js';
import { buildLedgerSeries, type ChartSeries, type ChartTooltip } from './ledger-chart-series.js';
import {
  type HoverApi,
  useChartHover,
  useChartViewport,
  useResizeWidth,
} from './use-chart-frame.js';

export type LedgerChartMode = 'daily' | 'cumulative';

interface LedgerChartProps {
  readonly enriched: readonly EnrichedLedgerEntry[];
  readonly mode: LedgerChartMode;
  /** "Today" injected so the chart stays pure-render — series builders
   *  can't call `new Date()`. Falls back to UTC today on the client. */
  readonly today?: string;
}

export function LedgerChart({ enriched, mode, today }: LedgerChartProps): React.ReactElement {
  // eslint-disable-next-line no-restricted-globals -- mirrors LedgerSummaryBar's optional-today pattern; series builders stay pure
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const series = useMemo<ChartSeries | null>(
    () => (enriched.length < 2 ? null : buildLedgerSeries(mode, enriched, todayStr)),
    [enriched, mode, todayStr],
  );
  if (series === null) {
    return (
      <Flex flex="1" align="center" justify="center" minH="180px">
        <Text fontSize="11px" color="term.ink3" fontFamily="mono">
          {enriched.length === 0 ? '暂无数据' : '至少需要 2 条记录才能绘图'}
        </Text>
      </Flex>
    );
  }
  return <ChartFrame series={series} />;
}

function ChartFrame({ series }: { readonly series: ChartSeries }): React.ReactElement {
  const { ref: wrapRef, width } = useResizeWidth(720);
  const innerW = Math.max(0, width - PRICE_AXIS_W);
  const { vp, onMouseDown, isDragging } = useChartViewport({
    seriesCount: series.count,
    seriesKey: seriesKeyOf(series),
    innerW,
    targetEl: wrapRef,
  });
  const slice = useMemo(() => visibleSlice(series.count, vp, innerW), [series.count, vp, innerW]);
  const hover = useChartHover({ slice, seriesCount: series.count, innerW, isDragging });
  const geom = useChartGeometry(series, slice, vp.candleW);
  const view = computeHoverView(hover, slice, series, geom.cxAt, geom.range);
  return (
    <Box ref={wrapRef} position="relative" flex="1" minH="200px" overflow="hidden">
      <ChartSvg
        series={series}
        slice={slice}
        candleW={vp.candleW}
        width={width}
        view={view}
        hover={hover}
        isDragging={isDragging}
        onMouseDown={onMouseDown}
        geom={geom}
      />
      {view.tooltip !== null && <HoverInfoBox tooltip={view.tooltip} />}
    </Box>
  );
}

interface ChartGeometry {
  readonly range: number;
  readonly yFor: (v: number) => number;
  readonly xForIndex: (i: number) => number;
  readonly cxAt: (i: number) => number;
  readonly yTicks: readonly number[];
  readonly dateTickKs: readonly number[];
}

function useChartGeometry(
  series: ChartSeries,
  slice: VisibleSlice,
  candleW: number,
): ChartGeometry {
  const range = Math.max(series.yMax - series.yMin, 1e-9);
  const yFor = useCallback(
    (v: number): number => INNER_BOTTOM - ((v - series.yMin) / range) * INNER_H,
    [range, series.yMin],
  );
  const xForIndex = useCallback(
    (i: number): number => slice.firstX + (i - slice.startIdx) * slice.stride,
    [slice],
  );
  const cxAt = useCallback((i: number): number => xForIndex(i) + candleW / 2, [candleW, xForIndex]);
  const yTicks = useMemo(
    () => priceTicks(series.yMin, series.yMax, PRICE_TICK_COUNT),
    [series.yMin, series.yMax],
  );
  const dateTickKs = useMemo(
    () => sparseIndices(slice.count, dateTickTarget(slice.count)),
    [slice.count],
  );
  return { range, yFor, xForIndex, cxAt, yTicks, dateTickKs };
}

interface ChartSvgProps {
  readonly series: ChartSeries;
  readonly slice: VisibleSlice;
  readonly candleW: number;
  readonly width: number;
  readonly view: HoverView;
  readonly hover: HoverApi;
  readonly isDragging: boolean;
  readonly onMouseDown: (e: React.MouseEvent<SVGSVGElement>) => void;
  readonly geom: ChartGeometry;
}

function ChartSvg(p: ChartSvgProps): React.ReactElement {
  return (
    <svg
      width="100%"
      height={HEIGHT}
      style={svgStyle(p.isDragging)}
      onPointerMove={p.hover.onPointerMove}
      onPointerLeave={p.hover.onPointerLeave}
      onMouseDown={p.onMouseDown}
      onMouseUp={p.hover.onMouseUp}
    >
      <ChartScene {...p} />
    </svg>
  );
}

function ChartScene({
  series,
  slice,
  candleW,
  width,
  view,
  geom,
}: ChartSvgProps): React.ReactElement {
  return (
    <>
      <YAxisLayer
        width={width}
        yTicks={geom.yTicks}
        yFor={geom.yFor}
        yMin={series.yMin}
        yMax={series.yMax}
        showZero={series.hasZero}
      />
      <g transform={`translate(${String(PRICE_AXIS_W)},0)`}>
        <BarsLayer
          series={series}
          slice={slice}
          candleW={candleW}
          xForIndex={geom.xForIndex}
          yFor={geom.yFor}
          hoverIdx={view.idx}
        />
        <XAxisLayer
          tickKs={geom.dateTickKs}
          startIdx={slice.startIdx}
          count={series.count}
          cxAt={geom.cxAt}
          dateAt={series.dateAt}
          hoverCx={view.cx}
        />
      </g>
      {view.cx !== null && view.cy !== null && view.date !== null && (
        <CrosshairLayer
          width={width}
          hoverCx={view.cx}
          hoverCy={view.cy}
          hoverDate={view.date}
          priceAtY={view.priceAtY ?? 0}
        />
      )}
    </>
  );
}

function svgStyle(dragging: boolean): React.CSSProperties {
  return {
    display: 'block',
    cursor: dragging ? 'grabbing' : 'crosshair',
    userSelect: 'none',
  };
}

function BarsLayer({
  series,
  slice,
  candleW,
  xForIndex,
  yFor,
  hoverIdx,
}: {
  readonly series: ChartSeries;
  readonly slice: VisibleSlice;
  readonly candleW: number;
  readonly xForIndex: (i: number) => number;
  readonly yFor: (v: number) => number;
  readonly hoverIdx: number | null;
}): React.ReactElement {
  return (
    <>
      {Array.from({ length: slice.count }, (_, k) => {
        const i = slice.startIdx + k;
        const opacity = hoverIdx === null || hoverIdx === i ? 1 : 0.45;
        return (
          <g key={`b-${String(i)}`} opacity={opacity}>
            {series.drawBar(i, xForIndex(i), candleW, yFor)}
          </g>
        );
      })}
    </>
  );
}

function HoverInfoBox({ tooltip }: { readonly tooltip: ChartTooltip }): React.ReactElement {
  return (
    <Box
      position="absolute"
      top="6px"
      right="8px"
      px="6px"
      py="2px"
      fontSize="10px"
      fontFamily="mono"
      color="term.ink"
      bg="term.panel"
      border="1px solid"
      borderColor="term.line"
      whiteSpace="nowrap"
      pointerEvents="none"
      lineHeight="1.3"
    >
      <div>{tooltip.line1}</div>
      <div>{tooltip.line2}</div>
    </Box>
  );
}

interface HoverView {
  readonly idx: number | null;
  readonly cx: number | null;
  readonly cy: number | null;
  readonly date: string | null;
  readonly tooltip: ChartTooltip | null;
  readonly priceAtY: number | null;
}

function computeHoverView(
  hover: HoverApi,
  slice: VisibleSlice,
  series: ChartSeries,
  cxAt: (i: number) => number,
  range: number,
): HoverView {
  const s = hover.state;
  if (s === null) return EMPTY_HOVER;
  const inSlice = s.idx >= slice.startIdx && s.idx < slice.startIdx + slice.count;
  if (!inSlice) return EMPTY_HOVER;
  return {
    idx: s.idx,
    cx: cxAt(s.idx),
    cy: s.cursorY,
    date: series.dateAt(s.idx),
    tooltip: series.tooltipAt(s.idx),
    priceAtY: series.yMin + ((INNER_BOTTOM - s.cursorY) / INNER_H) * range,
  };
}

const EMPTY_HOVER: HoverView = {
  idx: null,
  cx: null,
  cy: null,
  date: null,
  tooltip: null,
  priceAtY: null,
};

function seriesKeyOf(series: ChartSeries): string {
  return `${String(series.count)}::${series.count === 0 ? '' : series.dateAt(0)}::${
    series.count === 0 ? '' : series.dateAt(series.count - 1)
  }`;
}

function dateTickTarget(count: number): number {
  return Math.max(2, Math.min(7, Math.round(count / 8)));
}
