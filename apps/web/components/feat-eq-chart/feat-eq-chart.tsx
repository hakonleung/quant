'use client';

/**
 * EQ — Detail / price chart pane.
 *
 * Always loads 250D kline. Single SVG renders candles, MA lines, an
 * OHLC volume strip, the left price axis, the bottom date axis, a
 * crosshair with a price label, and date markers for the focused day.
 *
 * Interaction:
 *   - Default focus = latest bar (right edge of the viewport).
 *   - Mouse-move highlights the nearest bar (HOV).
 *   - Click a bar to pin selection (SEL); click the same bar again to
 *     clear back to HOV.
 *   - In SEL, clicking a different bar commits a range between the two
 *     (RANGE mode).
 *   - In RANGE, clicking inside the range keeps it; clicking outside
 *     clears the range back to HOV.
 *   - Drag the chart body to pan; +/- overlay zooms by adjusting candle
 *     width.
 *
 * Header actions: select-sectors dialog (multi-select diff). As of
 * the 2026-05 floating-island split, the fundamentals card moved to
 * `EQ.INFO` and the pattern-match table to `PAT` — both mount as
 * sibling tiles in the same column.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { KlineBar } from '@quant/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { uiRegistry } from '../../lib/ui-cmd/registry.js';

import { Feat } from '../../lib/eqty/feat.js';
import { FeatViewHeaderRight } from '../feat-view/feat-view-header.js';
import { MonoButton } from '../ui/mono-button.js';
import {
  clampViewport,
  DEFAULT_VIEWPORT,
  MAX_CANDLE_W,
  MIN_CANDLE_W,
  type ChartViewport,
} from '../../lib/fp/chart-view.js';
import { pctChangeToLatest } from '../../lib/fp/kline-chart.js';
import {
  KlinePeriods,
  resampleBars,
  type KlinePeriod,
} from '../../lib/fp/kline-resample.js';
import {
  ChartCanvas,
  DEFAULT_PRICE_H,
  DEFAULT_VOL_H,
  findRangeIndices,
  totalChartHeight,
} from './chart-canvas.js';
import { MA_COLOR_PATHS, getMaColors } from './chart-canvas-constants.js';
import type { MaKey } from '../../lib/fp/kline-chart.js';
import { useTokenColors } from '../../lib/theme/use-token-color.js';
import { useKline, useStockMetaQuery } from '../../lib/hooks/use-eqty-data.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { SelectSectorsDialog } from './select-sectors-dialog.js';

const TOTAL_H = totalChartHeight(DEFAULT_PRICE_H, DEFAULT_VOL_H);

interface Props {
  readonly code: string;
}

export function FeatEqChart({ code }: Props): React.ReactElement {
  const { data, isLoading } = useKline(code, '250D');
  const meta = useStockMetaQuery(code);
  const stockName = meta.data?.name ?? '';
  const period = useUiStore((s) => s.chartPeriod);
  const setPeriod = useUiStore((s) => s.setChartPeriod);
  const dailyBars = data ?? [];
  const bars = useMemo(() => resampleBars(dailyBars, period), [dailyBars, period]);

  // Zoom (candleW) is the only persisted slice of the viewport — it
  // travels with the user across stocks + reloads. `panPx` and `gap`
  // stay local because they're per-stock framing.
  const persistedCandleW = useUiStore((s) => s.chartCandleW);
  const setChartCandleW = useUiStore((s) => s.setChartCandleW);
  const [vp, setVpState] = useState<ChartViewport>(() => ({
    ...DEFAULT_VIEWPORT,
    candleW: persistedCandleW ?? DEFAULT_VIEWPORT.candleW,
  }));
  // Wrap setVp so any candleW change (auto-fit, zoom buttons, +/- hotkey,
  // wheel/pinch) gets mirrored to the persisted store in one shot —
  // call sites stay oblivious to persistence.
  const setVp = useCallback(
    (next: ChartViewport): void => {
      setVpState(next);
      setChartCandleW(next.candleW);
    },
    [setChartCandleW],
  );
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  const [showSectorsDialog, setShowSectorsDialog] = useState(false);
  const setChartRange = useUiStore((s) => s.setChartRange);
  const chartRange = useUiStore((s) => s.chartRange);

  // Hotkey handlers need the current `vp` without forcing a re-bind on
  // every viewport change — refs let the bound closures read fresh
  // values while the handler object identity stays stable.
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const zoomIn = useCallback((): void => {
    const cur = vpRef.current;
    setVp(clampViewport({ ...cur, candleW: Math.min(MAX_CANDLE_W, cur.candleW * 1.4) }));
  }, [setVp]);
  const zoomOut = useCallback((): void => {
    const cur = vpRef.current;
    setVp(clampViewport({ ...cur, candleW: Math.max(MIN_CANDLE_W, cur.candleW / 1.4) }));
  }, [setVp]);
  // The zoom cells live in 'global' scope (gated by a `when`
  // predicate to EQ.CHART / EQ.LIST); useFeatHotkeys insists on a
  // scope match, so bind directly. Unbinding on unmount keeps the
  // dispatch path quiet when no chart is mounted.
  useEffect(() => {
    const offIn = uiRegistry.bind('ui.chart-zoom-in', zoomIn);
    const offOut = uiRegistry.bind('ui.chart-zoom-out', zoomOut);
    return (): void => {
      offIn();
      offOut();
    };
  }, [zoomIn, zoomOut]);

  // Reset selection on series change. Viewport auto-fits to the new
  // series inside `ChartCanvas` (it knows the inner width); we just
  // clear stale focus state here.
  const seriesKey = bars.length === 0 ? '' : `${bars[0]!.date}-${bars[bars.length - 1]!.date}`;
  useEffect(() => {
    setSelectedIdx(null);
    setHoverIdx(null);
  }, [seriesKey]);

  // Esc clears the currently committed range for this code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (chartRange !== null && chartRange.code === code) {
        setChartRange(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [chartRange, code, setChartRange]);

  const committedRange = useMemo(
    () =>
      chartRange !== null && chartRange.code === code
        ? findRangeIndices(bars, chartRange.startDate, chartRange.endDate)
        : null,
    [chartRange, code, bars],
  );

  const onBarClick = (idx: number): void => {
    if (selectedIdx !== null) {
      if (selectedIdx === idx) {
        setSelectedIdx(null);
        return;
      }
      const lo = Math.min(selectedIdx, idx);
      const hi = Math.max(selectedIdx, idx);
      const startBar = bars[lo];
      const endBar = bars[hi];
      if (startBar !== undefined && endBar !== undefined) {
        setChartRange({ code, startDate: startBar.date, endDate: endBar.date });
      }
      setSelectedIdx(null);
      return;
    }
    if (committedRange !== null) {
      const inside = idx >= committedRange.start && idx <= committedRange.end;
      if (inside) return;
      setChartRange(null);
      return;
    }
    setSelectedIdx(idx);
  };

  const focusIdx = selectedIdx ?? hoverIdx ?? (bars.length > 0 ? bars.length - 1 : null);
  const focusBar = focusIdx === null ? null : (bars[focusIdx] ?? null);
  const deltaPct =
    focusIdx === null || focusIdx === bars.length - 1 ? null : pctChangeToLatest(bars, focusIdx);
  // Bars-ago count — unit depends on the active period (d / w / m).
  // We label it in the focus strip via {@link periodAgoLabel}.
  const barsAgo = focusIdx === null ? null : bars.length - 1 - focusIdx;
  // Day-over-day change for the focused bar — shown right after the
  // close so the price always carries its immediate context. First
  // bar in the series has no predecessor, so it stays null.
  const dayChgPct = ((): number | null => {
    if (focusIdx === null || focusIdx <= 0) return null;
    const prev = bars[focusIdx - 1];
    const cur = bars[focusIdx];
    if (prev === undefined || cur === undefined || prev.close === 0) return null;
    return cur.close / prev.close - 1;
  })();

  const maTokens = useTokenColors(MA_COLOR_PATHS);
  const maColors = useMemo(() => getMaColors(maTokens), [maTokens]);

  return (
    <FeatView
      feat={Feat.EquityChart}
      right={
        <ChartHeaderRight
          code={code}
          stockName={stockName}
          onSelectSectors={(): void => {
            setShowSectorsDialog(true);
          }}
        />
      }
    >
      <Flex direction="column" h="100%" minH={0}>
        <FocusLabel
          bar={focusBar}
          deltaPct={deltaPct}
          barsAgo={barsAgo}
          dayChgPct={dayChgPct}
          selected={selectedIdx !== null}
          hovered={selectedIdx === null && hoverIdx !== null}
          vp={vp}
          setVp={setVp}
          maColors={maColors}
          period={period}
          setPeriod={setPeriod}
        />
        <Box flex="1" minH={0}>
          <Box position="relative" h={`${String(TOTAL_H)}px`} bg="transparent">
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
                setHoverIdx={setHoverIdx}
                hoverPrice={hoverPrice}
                setHoverPrice={setHoverPrice}
                focusIdx={focusIdx}
                committedRange={committedRange}
                onBarClick={onBarClick}
                autoFit={persistedCandleW === null}
              />
            )}
          </Box>
        </Box>
      </Flex>
      <SelectSectorsDialog
        open={showSectorsDialog}
        code={code}
        onClose={(): void => {
          setShowSectorsDialog(false);
        }}
      />
    </FeatView>
  );
}

interface FocusProps {
  readonly bar: KlineBar | null;
  readonly deltaPct: number | null;
  /** Bars-ago count from the latest bar; unit derived from `period`. */
  readonly barsAgo: number | null;
  /** Day-over-day percent change for the focused bar — shown next to close. */
  readonly dayChgPct: number | null;
  readonly selected: boolean;
  readonly hovered: boolean;
  /** Viewport state — drives the inline zoom controls. */
  readonly vp: ChartViewport;
  readonly setVp: (vp: ChartViewport) => void;
  /** Theme-resolved MA palette (parent owns the `useTokenColors` call). */
  readonly maColors: Readonly<Record<MaKey, string>>;
  readonly period: KlinePeriod;
  readonly setPeriod: (p: KlinePeriod) => void;
}

const PERIOD_UNIT: Readonly<Record<KlinePeriod, string>> = { D: 'd', W: 'w', M: 'm' };

function FocusLabel({
  bar,
  deltaPct,
  barsAgo,
  dayChgPct,
  selected,
  hovered,
  vp,
  setVp,
  maColors,
  period,
  setPeriod,
}: FocusProps): React.ReactElement {
  const closeColor =
    bar === null ? 'ink2' : bar.close > bar.open ? 'up' : bar.close < bar.open ? 'down' : 'ink2';
  const tag =
    bar === null
      ? 'LATEST —'
      : selected
        ? `SEL ${bar.date}`
        : hovered
          ? `HOV ${bar.date}`
          : `LATEST ${bar.date}`;
  return (
    // Render the 2-row strip even when `bar` is null so the chart below
    // does not jump down once kline loads (avoids first-paint CLS).
    <Flex
      direction="column"
      px="14px"
      py="4px"
      gap="3px"
      borderBottomWidth="1px"
      borderColor="glass.line"
      bg="glass.panelSoft"
      backdropFilter="blur(12px)"
      fontFamily="mono"
      fontSize="xs"
      color="ink2"
    >
      {/* Row 1 — price · chgPct · 距今涨幅 · 换手/H/L/O · zoom controls. */}
      <Flex align="center" gap="12px" flexWrap="wrap">
        <Text
          fontFamily="mono"
          fontSize="body"
          color={closeColor}
          fontWeight="800"
          letterSpacing="0.04em"
        >
          {bar === null ? '—' : bar.close.toFixed(2)}
        </Text>
        {dayChgPct !== null && (
          <Text
            fontFamily="mono"
            fontSize="sm"
            color={dayChgPct >= 0 ? 'up' : 'down'}
            fontWeight="700"
            letterSpacing="0.04em"
          >
            {dayChgPct >= 0 ? '+' : ''}
            {(dayChgPct * 100).toFixed(2)}%
          </Text>
        )}
        {barsAgo !== null && deltaPct !== null && (
          <Stat
            label={`距今${String(barsAgo)}${PERIOD_UNIT[period]}`}
            value={`${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`}
            color={deltaPct >= 0 ? 'up' : 'down'}
            bold
          />
        )}
        <Stat label="换手" value={bar === null ? '—' : `${(bar.turnoverRate * 100).toFixed(2)}%`} />
        <Stat label="H" value={bar === null ? '—' : bar.high.toFixed(2)} color="up" />
        <Stat label="L" value={bar === null ? '—' : bar.low.toFixed(2)} color="down" />
        <Stat label="O" value={bar === null ? '—' : bar.open.toFixed(2)} />
        {/* Period toggle pinned right; zoom controls live directly
            below in row 2 so the two right-aligned widgets stack. */}
        <Box ml="auto">
          <PeriodToggle period={period} setPeriod={setPeriod} />
        </Box>
      </Flex>
      {/* Row 2 — focus tag (LATEST / SEL / HOV) + MA5/10/20/60. The
          tag lives next to the MAs so row 1 stays compact and reads
          as the price summary; the date / mode tag pairs naturally
          with the secondary indicator strip. */}
      <Flex align="center" gap="12px" flexWrap="wrap">
        <Box
          as="span"
          px="5px"
          py={0}
          borderWidth="1px"
          borderColor={selected ? 'accent' : 'line'}
          color={selected ? 'accent' : 'ink3'}
          bg={selected ? 'accentBg' : 'transparent'}
          fontSize="xs"
          fontWeight="700"
          letterSpacing="0.12em"
        >
          {tag}
        </Box>
        <MaInline ma="MA5" value={bar?.ma5 ?? null} color={maColors.ma5} />
        <MaInline ma="MA10" value={bar?.ma10 ?? null} color={maColors.ma10} />
        <MaInline ma="MA20" value={bar?.ma20 ?? null} color={maColors.ma20} />
        <MaInline ma="MA60" value={bar?.ma60 ?? null} color={maColors.ma60} />
        <Box ml="auto">
          <ZoomControls vp={vp} setVp={setVp} />
        </Box>
      </Flex>
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
    <Box fontFamily="mono">
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
    <Box fontFamily="mono">
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
      fontSize="xs"
      letterSpacing="0.16em"
    >
      {children}
    </Text>
  );
}

interface ZoomControlsProps {
  readonly vp: ChartViewport;
  readonly setVp: (vp: ChartViewport) => void;
}

/**
 * Inline +/- zoom buttons. Lives inside `FocusLabel`'s indicator strip
 * — `Box ml="auto"` on the wrapper pins it to the right edge of the
 * row regardless of how many wrap-lines the rest of the strip uses.
 * No absolute positioning, so the controls flow with the bar height
 * and don't have to fight z-index or `pointerEvents` against the chart
 * canvas underneath.
 */
function ZoomControls({ vp, setVp }: ZoomControlsProps): React.ReactElement {
  const zoomIn = (): void => {
    setVp(clampViewport({ ...vp, candleW: Math.min(MAX_CANDLE_W, vp.candleW * 1.4) }));
  };
  const zoomOut = (): void => {
    setVp(clampViewport({ ...vp, candleW: Math.max(MIN_CANDLE_W, vp.candleW / 1.4) }));
  };
  return (
    <Flex gap="4px" align="center">
      <MonoButton icon="minimize" label="zoom out" onClick={zoomOut} />
      <MonoButton icon="add" label="zoom in" onClick={zoomIn} />
    </Flex>
  );
}

interface PeriodToggleProps {
  readonly period: KlinePeriod;
  readonly setPeriod: (p: KlinePeriod) => void;
}

const PERIOD_LABELS: Readonly<Record<KlinePeriod, string>> = {
  D: 'D',
  W: 'W',
  M: 'M',
};

const PERIOD_ARIA: Readonly<Record<KlinePeriod, string>> = {
  D: '日线',
  W: '周线',
  M: '月线',
};

function PeriodToggle({ period, setPeriod }: PeriodToggleProps): React.ReactElement {
  return (
    <Flex
      role="group"
      aria-label="kline period"
      borderWidth="1px"
      borderColor="line"
      fontFamily="mono"
      fontSize="xs"
      letterSpacing="0.08em"
    >
      {KlinePeriods.map((p) => {
        const active = p === period;
        return (
          <Box
            as="button"
            key={p}
            onClick={(): void => {
              setPeriod(p);
            }}
            px="6px"
            py="1px"
            color={active ? 'accent' : 'ink3'}
            bg={active ? 'accentBg' : 'transparent'}
            fontWeight="700"
            cursor="pointer"
            _hover={active ? {} : { color: 'ink' }}
            aria-pressed={active}
            aria-label={PERIOD_ARIA[p]}
          >
            {PERIOD_LABELS[p]}
          </Box>
        );
      })}
    </Flex>
  );
}

interface HeaderRightProps {
  readonly code: string;
  readonly stockName: string;
  readonly onSelectSectors: () => void;
}

function ChartHeaderRight({
  code,
  stockName,
  onSelectSectors,
}: HeaderRightProps): React.ReactElement {
  return (
    <Flex align="center" gap="8px">
      <Text>{code}</Text>
      {stockName !== '' && <Text>{stockName}</Text>}
      <FeatViewHeaderRight>
        <MonoButton icon="star" label="select sectors" onClick={onSelectSectors} />
      </FeatViewHeaderRight>
    </Flex>
  );
}

