'use client';

/**
 * 101 — Detail / price chart.
 *
 * Always loads 250D kline. Single SVG renders candles, MA lines, an
 * OHLC volume strip, the left price axis, the bottom date axis, a
 * crosshair with a price label, and date markers for the focused day.
 *
 * Interaction:
 *   - Default focus = latest bar (right edge of the viewport).
 *   - Mouse-move highlights the nearest bar; hover and selection share
 *     the same label payload, the only difference is whether the focus
 *     is sticky.
 *   - Click a bar to pin selection; click the same bar again to clear.
 *   - Drag the chart body to pan; +/- buttons zoom by adjusting candle
 *     width.
 *
 * Header actions: blacklist (with confirm) + add-to-sector dialog.
 */

import { Box, Button, Flex, HStack, Text } from '@chakra-ui/react';
import type { KlineBar } from '@quant/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import {
  clampViewport,
  DEFAULT_VIEWPORT,
  indexAtX,
  MAX_CANDLE_W,
  MIN_CANDLE_W,
  priceBounds,
  visibleSlice,
  type ChartViewport,
} from '../../lib/fp/chart-view.js';
import { pctChangeToLatest, sparseIndices, type MaKey } from '../../lib/fp/kline-chart.js';
import { useKline, useStockMetaQuery } from '../../lib/hooks/use-eqty-data.js';
import { useBlacklistStore } from '../../lib/stores/blacklist.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { palette } from '../../lib/theme/tokens.js';
import { Pane } from '../shell/pane.js';
import { AddToSectorDialog } from './add-to-sector-dialog.js';

// Render space — height fixed; width fills container via SVG width=100%.
const PRICE_H = 240;
const VOL_H = 64;
const VOL_GAP = 4;
const TOP_PAD = 8;
const BOTTOM_PAD = 8;
const PRICE_AXIS_W = 48;
const TOTAL_H = PRICE_H + VOL_GAP + VOL_H + 22; // last 22 = bottom date axis

const MA_COLORS: Readonly<Record<MaKey, string>> = {
  // Smaller window -> deeper / warmer color.
  ma5: '#7a3a05',
  ma10: '#a66610',
  ma20: '#d59231',
  ma60: '#e3b975',
};

interface Props {
  readonly code: string;
}

export function ChartPanel({ code }: Props): React.ReactElement {
  const { data, isLoading } = useKline(code, '250D');
  const meta = useStockMetaQuery(code);
  const stockName = meta.data?.name ?? '';
  const bars = data ?? [];

  const [vp, setVp] = useState<ChartViewport>(DEFAULT_VIEWPORT);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [rangeAnchor, setRangeAnchor] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  const setChartRange = useUiStore((s) => s.setChartRange);
  const chartRange = useUiStore((s) => s.chartRange);

  // Reset viewport whenever the underlying series changes.
  const seriesKey = bars.length === 0 ? '' : `${bars[0]!.date}-${bars[bars.length - 1]!.date}`;
  useEffect(() => {
    setVp(DEFAULT_VIEWPORT);
    setSelectedIdx(null);
    setHoverIdx(null);
    setRangeAnchor(null);
    setRangeEnd(null);
  }, [seriesKey]);

  const commitRange = (a: number, b: number): void => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const startBar = bars[lo];
    const endBar = bars[hi];
    if (startBar === undefined || endBar === undefined) return;
    setChartRange({
      code,
      startDate: startBar.date,
      endDate: endBar.date,
    });
  };

  const focusIdx = selectedIdx ?? hoverIdx ?? (bars.length > 0 ? bars.length - 1 : null);
  const focusBar = focusIdx === null ? null : (bars[focusIdx] ?? null);
  const deltaPct =
    focusIdx === null || focusIdx === bars.length - 1 ? null : pctChangeToLatest(bars, focusIdx);
  const daysAgo = focusIdx === null ? null : bars.length - 1 - focusIdx;

  return (
    <Pane
      feat={Feat.Chart}
      right={
        <Text>
          {code}
          {stockName === '' ? '' : ` · ${stockName}`}
        </Text>
      }
    >
      <ChartTools
        code={code}
        stockName={stockName}
        vp={vp}
        setVp={setVp}
        onAddToSector={(): void => {
          setShowAddDialog(true);
        }}
      />
      <FocusLabel
        bar={focusBar}
        deltaPct={deltaPct}
        daysAgo={daysAgo}
        selected={selectedIdx !== null}
        hovered={selectedIdx === null && hoverIdx !== null}
      />
      <Box position="relative" h={`${String(TOTAL_H)}px`} bg="panel">
        {isLoading ? (
          <Centered>loading kline…</Centered>
        ) : bars.length === 0 ? (
          <Centered>// no kline data</Centered>
        ) : (
          <ChartCanvas
            bars={bars}
            vp={vp}
            setVp={setVp}
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            setHoverIdx={setHoverIdx}
            hoverPrice={hoverPrice}
            setHoverPrice={setHoverPrice}
            focusIdx={focusIdx}
            rangeAnchor={rangeAnchor}
            rangeEnd={rangeEnd}
            committedRange={
              chartRange !== null && chartRange.code === code
                ? findRangeIndices(bars, chartRange.startDate, chartRange.endDate)
                : null
            }
            onRangeStart={(idx): void => {
              setRangeAnchor(idx);
              setRangeEnd(idx);
            }}
            onRangeMove={(idx): void => {
              if (rangeAnchor !== null) setRangeEnd(idx);
            }}
            onRangeEnd={(): void => {
              if (rangeAnchor !== null && rangeEnd !== null && rangeAnchor !== rangeEnd) {
                commitRange(rangeAnchor, rangeEnd);
              }
              setRangeAnchor(null);
              setRangeEnd(null);
            }}
          />
        )}
      </Box>
      <AddToSectorDialog
        open={showAddDialog}
        code={code}
        onClose={(): void => {
          setShowAddDialog(false);
        }}
      />
    </Pane>
  );
}

interface CanvasProps {
  readonly bars: readonly KlineBar[];
  readonly vp: ChartViewport;
  readonly setVp: (next: ChartViewport) => void;
  readonly selectedIdx: number | null;
  readonly setSelectedIdx: (n: number | null) => void;
  readonly setHoverIdx: (n: number | null) => void;
  readonly hoverPrice: number | null;
  readonly setHoverPrice: (p: number | null) => void;
  readonly focusIdx: number | null;
  readonly rangeAnchor: number | null;
  readonly rangeEnd: number | null;
  readonly committedRange: { readonly start: number; readonly end: number } | null;
  readonly onRangeStart: (idx: number) => void;
  readonly onRangeMove: (idx: number) => void;
  readonly onRangeEnd: () => void;
}

function ChartCanvas({
  bars,
  vp,
  setVp,
  selectedIdx,
  setSelectedIdx,
  setHoverIdx,
  hoverPrice,
  setHoverPrice,
  focusIdx,
  rangeAnchor,
  rangeEnd,
  committedRange,
  onRangeStart,
  onRangeMove,
  onRangeEnd,
}: CanvasProps): React.ReactElement {
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

  const innerW = Math.max(0, width - PRICE_AXIS_W);
  const slice = useMemo(() => visibleSlice(bars.length, vp, innerW), [bars.length, vp, innerW]);
  const bounds = useMemo(
    () => priceBounds(bars, slice.startIdx, slice.count),
    [bars, slice.startIdx, slice.count],
  );
  const usableH = PRICE_H - TOP_PAD - BOTTOM_PAD;
  const range = bounds.max - bounds.min || 1;
  const scaleY = useCallback(
    (price: number): number => PRICE_H - BOTTOM_PAD - ((price - bounds.min) / range) * usableH,
    [bounds.min, range, usableH],
  );
  const inverseY = useCallback(
    (y: number): number => bounds.min + ((PRICE_H - BOTTOM_PAD - y) / usableH) * range,
    [bounds.min, range, usableH],
  );

  const xForIndex = useCallback(
    (idx: number): number => slice.firstX + (idx - slice.startIdx) * slice.stride,
    [slice],
  );

  const dragRef = useRef<{
    startX: number;
    startPan: number;
    moved: boolean;
    isRange: boolean;
  } | null>(null);

  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - PRICE_AXIS_W;
    const y = e.clientY - rect.top;
    if (e.shiftKey && x >= 0 && y >= 0 && y <= PRICE_H) {
      const idx = indexAtX(x, slice, bars.length);
      if (idx !== null) {
        onRangeStart(idx);
        dragRef.current = { startX: e.clientX, startPan: vp.panPx, moved: false, isRange: true };
        return;
      }
    }
    dragRef.current = { startX: e.clientX, startPan: vp.panPx, moved: false, isRange: false };
  };
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - PRICE_AXIS_W;
    const y = e.clientY - rect.top;
    if (dragRef.current !== null) {
      if (dragRef.current.isRange) {
        if (x >= 0 && y >= 0 && y <= PRICE_H) {
          const idx = indexAtX(x, slice, bars.length);
          if (idx !== null) onRangeMove(idx);
        }
        dragRef.current.moved = true;
        return;
      }
      const dx = e.clientX - dragRef.current.startX;
      if (Math.abs(dx) > 2) dragRef.current.moved = true;
      const nextPan = Math.max(0, dragRef.current.startPan - dx);
      setVp(clampViewport({ ...vp, panPx: nextPan }));
      return;
    }
    if (x >= 0 && y >= 0 && y <= PRICE_H) {
      const idx = indexAtX(x, slice, bars.length);
      setHoverIdx(idx);
      setHoverPrice(inverseY(y));
    } else {
      setHoverIdx(null);
      setHoverPrice(null);
    }
  };
  const onMouseUp = (e: React.MouseEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.isRange === true) {
      onRangeEnd();
      return;
    }
    if (drag?.moved === true) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - PRICE_AXIS_W;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || y > PRICE_H) return;
    const idx = indexAtX(x, slice, bars.length);
    if (idx === null) return;
    setSelectedIdx(selectedIdx === idx ? null : idx);
  };
  const onMouseLeave = (): void => {
    if (dragRef.current?.isRange === true) onRangeEnd();
    dragRef.current = null;
    setHoverIdx(null);
    setHoverPrice(null);
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
            height={PRICE_H + VOL_GAP + VOL_H}
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
    const volH = volMax === 0 ? 0 : (b.volume / volMax) * (VOL_H - 4);
    volBars.push(
      <rect
        key={`v-${String(i)}`}
        x={x}
        y={PRICE_H + VOL_GAP + (VOL_H - volH)}
        width={vp.candleW}
        height={Math.max(1, volH)}
        fill={col}
        opacity={focusIdx === null || focusIdx === i ? 0.85 : 0.4}
      />,
    );
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

  // ----- price axis ticks (sparse) -----
  const priceTickCount = 5;
  const priceTicks: number[] = [];
  for (let i = 0; i < priceTickCount; i += 1) {
    priceTicks.push(bounds.min + ((bounds.max - bounds.min) / (priceTickCount - 1)) * i);
  }

  // ----- date axis ticks (sparse) -----
  const targetDateTicks = Math.max(2, Math.min(8, Math.round(slice.count / 12)));
  const dateTickIdx = sparseIndices(slice.count, targetDateTicks).map((k) => slice.startIdx + k);

  return (
    <Box ref={wrapRef} w="100%" h={`${String(TOTAL_H)}px`} position="relative">
      <svg
        width="100%"
        height={TOTAL_H}
        style={{ display: 'block', cursor: dragRef.current === null ? 'crosshair' : 'grabbing' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      >
        {/* Background separator */}
        <line
          x1={PRICE_AXIS_W}
          x2={width}
          y1={PRICE_H}
          y2={PRICE_H}
          stroke={palette.light.line}
        />
        <line
          x1={PRICE_AXIS_W}
          x2={width}
          y1={PRICE_H + VOL_GAP + VOL_H}
          y2={PRICE_H + VOL_GAP + VOL_H}
          stroke={palette.light.line}
        />

        {/* Price axis (left) */}
        {priceTicks.map((p, i) => {
          const y = scaleY(p);
          return (
            <g key={`pt-${String(i)}`}>
              <line
                x1={PRICE_AXIS_W - 3}
                x2={width}
                y1={y}
                y2={y}
                stroke={palette.light.line2}
              />
              <text
                x={PRICE_AXIS_W - 6}
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

        {/* Plot, translated past the price axis */}
        <g transform={`translate(${String(PRICE_AXIS_W)},0)`}>
          {/* Active drag selection overlay */}
          {rangeAnchor !== null && rangeEnd !== null && (
            <rect
              x={Math.min(xForIndex(rangeAnchor), xForIndex(rangeEnd))}
              y={0}
              width={Math.abs(xForIndex(rangeEnd) - xForIndex(rangeAnchor)) + vp.candleW}
              height={PRICE_H + VOL_GAP + VOL_H}
              fill="rgba(30,98,200,0.10)"
              stroke="rgba(30,98,200,0.55)"
              strokeDasharray="3 3"
            />
          )}
          {/* Committed range overlay */}
          {committedRange !== null && rangeAnchor === null && (
            <rect
              x={xForIndex(committedRange.start)}
              y={0}
              width={
                xForIndex(committedRange.end) - xForIndex(committedRange.start) + vp.candleW
              }
              height={PRICE_H + VOL_GAP + VOL_H}
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
          <text
            x={6}
            y={PRICE_H + 12}
            fontSize="9"
            fontFamily="JetBrains Mono"
            fill={palette.light.ink3}
            letterSpacing="0.16em"
          >
            VOL
          </text>

          {/* Date axis */}
          {dateTickIdx.map((idx) => {
            const b = bars[idx];
            if (b === undefined) return null;
            const x = xForIndex(idx) + vp.candleW / 2;
            return (
              <text
                key={`dt-${String(idx)}`}
                x={x}
                y={TOTAL_H - 6}
                fontSize="9"
                fontFamily="JetBrains Mono"
                fill={palette.light.ink3}
                textAnchor="middle"
              >
                {b.date.slice(5)}
              </text>
            );
          })}

          {/* Focus date marker */}
          {focusIdx !== null && bars[focusIdx] !== undefined && (
            <g>
              <rect
                x={xForIndex(focusIdx) - 16}
                y={TOTAL_H - 18}
                width={Math.max(40, vp.candleW + 32)}
                height={14}
                fill={palette.light.amberBg}
                stroke={palette.light.amber}
              />
              <text
                x={xForIndex(focusIdx) + vp.candleW / 2}
                y={TOTAL_H - 8}
                fontSize="9"
                fontFamily="JetBrains Mono"
                fill={palette.light.amberDark}
                textAnchor="middle"
                fontWeight="700"
              >
                {bars[focusIdx]!.date}
              </text>
            </g>
          )}
        </g>

        {/* Hover crosshair (price) */}
        {hoverPrice !== null && selectedIdx === null && (
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
              width={PRICE_AXIS_W - 2}
              height={14}
              fill={palette.light.amberBg}
              stroke={palette.light.amber}
            />
            <text
              x={PRICE_AXIS_W - 6}
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

interface FocusProps {
  readonly bar: KlineBar | null;
  readonly deltaPct: number | null;
  readonly daysAgo: number | null;
  readonly selected: boolean;
  readonly hovered: boolean;
}

function FocusLabel({
  bar,
  deltaPct,
  daysAgo,
  selected,
  hovered,
}: FocusProps): React.ReactElement {
  if (bar === null) {
    return (
      <Box px="14px" py="4px" borderBottomWidth="1px" borderColor="line" bg="panel3">
        <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.12em">
          // no bar
        </Text>
      </Box>
    );
  }
  const closeColor =
    bar.close > bar.open ? 'up' : bar.close < bar.open ? 'down' : 'ink2';
  const tag = selected ? `SEL ${bar.date}` : hovered ? `HOV ${bar.date}` : `LATEST ${bar.date}`;
  return (
    <Flex
      px="14px"
      py="4px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      align="center"
      gap="12px"
      fontFamily="mono"
      fontSize="10px"
      color="ink2"
      flexWrap="wrap"
    >
      <Box
        as="span"
        px="5px"
        py={0}
        borderWidth="1px"
        borderColor={selected ? 'accent' : 'line'}
        color={selected ? 'accent' : 'ink3'}
        bg={selected ? 'accentBg' : 'transparent'}
        fontSize="9px"
        fontWeight="700"
        letterSpacing="0.12em"
      >
        {tag}
      </Box>
      <Text fontSize="13px" color={closeColor} fontWeight="800" letterSpacing="0.04em">
        {bar.close.toFixed(2)}
      </Text>
      {daysAgo !== null && deltaPct !== null && (
        <Stat
          label={`距今${String(daysAgo)}d`}
          value={`${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`}
          color={deltaPct >= 0 ? 'up' : 'down'}
          bold
        />
      )}
      <Stat label="换手" value={`${(bar.turnoverRate * 100).toFixed(2)}%`} />
      <Stat label="H" value={bar.high.toFixed(2)} color="up" />
      <Stat label="L" value={bar.low.toFixed(2)} color="down" />
      <Stat label="O" value={bar.open.toFixed(2)} />
      <MaInline ma="MA5" value={bar.ma5} color={MA_COLORS.ma5} />
      <MaInline ma="MA10" value={bar.ma10} color={MA_COLORS.ma10} />
      <MaInline ma="MA20" value={bar.ma20} color={MA_COLORS.ma20} />
      <MaInline ma="MA60" value={bar.ma60} color={MA_COLORS.ma60} />
    </Flex>
  );
}

function Stat({
  label,
  value,
  color,
  bold = false,
}: {
  label: string;
  value: string;
  color?: string;
  bold?: boolean;
}): React.ReactElement {
  return (
    <Box>
      <Text as="span" color="ink3" letterSpacing="0.14em">
        {label}
      </Text>{' '}
      <Text as="span" color={color ?? 'ink'} fontWeight={bold ? '700' : '600'}>
        {value}
      </Text>
    </Box>
  );
}

function MaInline({
  ma,
  value,
  color,
}: {
  ma: string;
  value: number | null;
  color: string;
}): React.ReactElement {
  return (
    <Box>
      <Text as="span" color={color} letterSpacing="0.10em" fontWeight="700">
        {ma}
      </Text>{' '}
      <Text as="span" color="ink">
        {value === null ? '—' : value.toFixed(2)}
      </Text>
    </Box>
  );
}

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text
      position="absolute"
      top="50%"
      left="50%"
      transform="translate(-50%,-50%)"
      fontFamily="mono"
      color="ink3"
      fontSize="11px"
      letterSpacing="0.16em"
    >
      {children}
    </Text>
  );
}

interface ToolsProps {
  readonly code: string;
  readonly stockName: string;
  readonly vp: ChartViewport;
  readonly setVp: (vp: ChartViewport) => void;
  readonly onAddToSector: () => void;
}

function ChartTools({
  code,
  stockName,
  vp,
  setVp,
  onAddToSector,
}: ToolsProps): React.ReactElement {
  const blacklist = useBlacklistStore((s) => s.entries);
  const addBlacklist = useBlacklistStore((s) => s.add);
  const alreadyBlacklisted = blacklist.some((b) => b.code === code);

  const onBlacklist = (): void => {
    if (alreadyBlacklisted) return;
    if (!confirm(`Blacklist ${code}${stockName === '' ? '' : ` (${stockName})`}?`)) return;
    if (!confirm(`Confirm: blacklist ${code} permanently?`)) return;
    addBlacklist({
      code,
      name: stockName,
      addedAt: new Date().toISOString().slice(0, 10),
      note: '',
    });
  };

  const zoomIn = (): void => {
    setVp(clampViewport({ ...vp, candleW: Math.min(MAX_CANDLE_W, vp.candleW * 1.4) }));
  };
  const zoomOut = (): void => {
    setVp(clampViewport({ ...vp, candleW: Math.max(MIN_CANDLE_W, vp.candleW / 1.4) }));
  };
  const resetView = (): void => {
    setVp(DEFAULT_VIEWPORT);
  };

  return (
    <Flex
      align="center"
      gap="6px"
      px="12px"
      py="6px"
      borderBottomWidth="1px"
      borderColor="line"
      fontFamily="mono"
      fontSize="10px"
      color="ink3"
      letterSpacing="0.14em"
    >
      <ToolButton onClick={zoomOut} title="zoom out">
        −
      </ToolButton>
      <ToolButton onClick={zoomIn} title="zoom in">
        +
      </ToolButton>
      <ToolButton onClick={resetView} title="reset">
        ⟲
      </ToolButton>
      <HStack ml="auto" gap="6px">
        <ToolButton
          onClick={onAddToSector}
          title="add to sector"
        >
          + SECTOR
        </ToolButton>
        <ToolButton
          onClick={onBlacklist}
          danger
          disabled={alreadyBlacklisted}
          title={alreadyBlacklisted ? 'already blacklisted' : 'blacklist (asks twice)'}
        >
          {alreadyBlacklisted ? '✓ BLK' : 'BLACKLIST'}
        </ToolButton>
      </HStack>
    </Flex>
  );
}

interface ButtonProps {
  readonly children: React.ReactNode;
  readonly onClick?: () => void;
  readonly title?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

function findRangeIndices(
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

function ToolButton({
  children,
  onClick,
  title,
  danger = false,
  disabled = false,
}: ButtonProps): React.ReactElement {
  return (
    <Button
      h="auto"
      px="8px"
      py="3px"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.14em"
      textTransform="uppercase"
      bg="panel"
      color={danger ? 'up' : 'ink2'}
      borderWidth="1px"
      borderColor={danger ? 'up' : 'line'}
      borderRadius="0"
      fontWeight="500"
      onClick={onClick}
      disabled={disabled}
      title={title}
      _hover={disabled ? {} : { bg: 'hover' }}
    >
      {children}
    </Button>
  );
}
