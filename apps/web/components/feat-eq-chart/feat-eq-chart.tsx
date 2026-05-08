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
 * Header actions: select-sectors dialog (multi-select diff). The
 * SCR.PAT pattern-match table is embedded inline below the
 * fundamentals so the pattern range follows the chart's lifecycle.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { KlineBar, StockMetaDto } from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';

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
  ChartCanvas,
  DEFAULT_PRICE_H,
  DEFAULT_VOL_H,
  MA_COLORS,
  findRangeIndices,
  totalChartHeight,
} from './chart-canvas.js';
import { useKline, useStockMetaQuery, useStockSnapshots } from '../../lib/hooks/use-eqty-data.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { ScrPatSection } from '../feat-scr-pat/scr-pat-section.js';
import { SelectSectorsDialog } from './select-sectors-dialog.js';

const TOTAL_H = totalChartHeight(DEFAULT_PRICE_H, DEFAULT_VOL_H);

interface Props {
  readonly code: string;
}

export function FeatEqChart({ code }: Props): React.ReactElement {
  const { data, isLoading } = useKline(code, '250D');
  const meta = useStockMetaQuery(code);
  const stockName = meta.data?.name ?? '';
  const bars = data ?? [];

  const [vp, setVp] = useState<ChartViewport>(DEFAULT_VIEWPORT);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  const [showSectorsDialog, setShowSectorsDialog] = useState(false);
  const setChartRange = useUiStore((s) => s.setChartRange);
  const chartRange = useUiStore((s) => s.chartRange);

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
  const daysAgo = focusIdx === null ? null : bars.length - 1 - focusIdx;
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
          daysAgo={daysAgo}
          dayChgPct={dayChgPct}
          selected={selectedIdx !== null}
          hovered={selectedIdx === null && hoverIdx !== null}
          vp={vp}
          setVp={setVp}
        />
        <Box flex="1" minH={0}>
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
                setHoverIdx={setHoverIdx}
                hoverPrice={hoverPrice}
                setHoverPrice={setHoverPrice}
                focusIdx={focusIdx}
                committedRange={committedRange}
                onBarClick={onBarClick}
              />
            )}
          </Box>
          <FinancialsSection code={code} meta={meta.data ?? null} />
          <ScrPatSection />
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
  readonly daysAgo: number | null;
  /** Day-over-day percent change for the focused bar — shown next to close. */
  readonly dayChgPct: number | null;
  readonly selected: boolean;
  readonly hovered: boolean;
  /** Viewport state — drives the inline zoom controls. */
  readonly vp: ChartViewport;
  readonly setVp: (vp: ChartViewport) => void;
}

function FocusLabel({
  bar,
  deltaPct,
  daysAgo,
  dayChgPct,
  selected,
  hovered,
  vp,
  setVp,
}: FocusProps): React.ReactElement {
  if (bar === null) {
    return (
      <Flex
        px="14px"
        py="4px"
        borderBottomWidth="1px"
        borderColor="line"
        bg="panel3"
        align="center"
        justify="space-between"
      >
        <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.12em">
          // no bar
        </Text>
        <ZoomControls vp={vp} setVp={setVp} />
      </Flex>
    );
  }
  const closeColor = bar.close > bar.open ? 'up' : bar.close < bar.open ? 'down' : 'ink2';
  const tag = selected ? `SEL ${bar.date}` : hovered ? `HOV ${bar.date}` : `LATEST ${bar.date}`;
  return (
    <Flex
      direction="column"
      px="14px"
      py="4px"
      gap="3px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      fontFamily="mono"
      fontSize="10px"
      color="ink2"
    >
      {/* Row 1 — price · chgPct · 距今涨幅 · 换手/H/L/O · zoom controls. */}
      <Flex align="center" gap="12px" flexWrap="wrap">
        <Text
          fontFamily="mono"
          fontSize="13px"
          color={closeColor}
          fontWeight="800"
          letterSpacing="0.04em"
        >
          {bar.close.toFixed(2)}
        </Text>
        {dayChgPct !== null && (
          <Text
            fontFamily="mono"
            fontSize="12px"
            color={dayChgPct >= 0 ? 'up' : 'down'}
            fontWeight="700"
            letterSpacing="0.04em"
          >
            {dayChgPct >= 0 ? '+' : ''}
            {(dayChgPct * 100).toFixed(2)}%
          </Text>
        )}
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
        {/* `ml="auto"` pins the zoom controls to the right edge no
            matter how many wrap-rows row 1 spans. */}
        <Box ml="auto">
          <ZoomControls vp={vp} setVp={setVp} />
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
          fontSize="9px"
          fontWeight="700"
          letterSpacing="0.12em"
        >
          {tag}
        </Box>
        <MaInline ma="MA5" value={bar.ma5} color={MA_COLORS.ma5} />
        <MaInline ma="MA10" value={bar.ma10} color={MA_COLORS.ma10} />
        <MaInline ma="MA20" value={bar.ma20} color={MA_COLORS.ma20} />
        <MaInline ma="MA60" value={bar.ma60} color={MA_COLORS.ma60} />
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
      fontSize="11px"
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

interface FinancialsProps {
  readonly code: string;
  readonly meta: StockMetaDto | null;
}

function FinancialsSection({ code, meta }: FinancialsProps): React.ReactElement {
  const codes = useMemo(() => [code], [code]);
  const snapshots = useStockSnapshots(codes);
  const snap = snapshots.byCode.get(code) ?? null;
  const derived = snap?.derived ?? null;
  const latestQ =
    meta !== null && meta.quarterlies.length > 0
      ? meta.quarterlies[meta.quarterlies.length - 1]!
      : null;

  return (
    <Box
      px="14px"
      py="10px"
      borderTopWidth="1px"
      borderColor="line"
      bg="panel3"
      fontFamily="mono"
      fontSize="11px"
      color="ink2"
    >
      <Text color="ink3" fontSize="9px" letterSpacing="0.16em" textTransform="uppercase" mb="6px">
        FUNDAMENTALS
      </Text>
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap="4px 16px">
        <FinCell label="MKT CAP" value={fmtCny(derived?.mkt_cap ?? null)} />
        <FinCell label="FLOAT MC" value={fmtCny(derived?.float_mkt_cap ?? null)} />
        <FinCell label="PE TTM" value={fmtNum(derived?.pe_ttm ?? null)} />
        <FinCell label="PE DYN" value={fmtNum(derived?.pe_dynamic ?? null)} />
        <FinCell label="PB" value={fmtNum(derived?.pb ?? null)} />
        <FinCell label="PEG" value={fmtNum(derived?.peg ?? null)} />
        <FinCell label="GM TTM" value={fmtPct(derived?.gross_margin_ttm ?? null)} />
        <FinCell label="NET ASSETS" value={fmtCny(meta?.net_assets ?? null)} />
        <FinCell label="TOTAL SHARE" value={fmtShare(meta?.total_share ?? null)} />
        <FinCell label="FLOAT SHARE" value={fmtShare(meta?.float_share ?? null)} />
      </Box>
      {latestQ !== null && (
        <Box mt="8px" pt="6px" borderTopWidth="1px" borderColor="line2">
          <Text color="ink3" fontSize="9px" letterSpacing="0.16em" mb="4px">
            LATEST QUARTER {latestQ.period}
          </Text>
          <Box
            display="grid"
            gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
            gap="4px 16px"
          >
            <FinCell label="REVENUE" value={fmtCny(latestQ.revenue)} />
            <FinCell label="OP COST" value={fmtCny(latestQ.operating_cost)} />
            <FinCell label="NET PROFIT" value={fmtCny(latestQ.net_profit)} />
            <FinCell label="NET PROFIT EXNR" value={fmtCny(latestQ.net_profit_excl_nr)} />
          </Box>
        </Box>
      )}
    </Box>
  );
}

function FinCell({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Flex gap="6px" align="baseline">
      <Text color="ink3" letterSpacing="0.10em" fontSize="9px" minW="64px">
        {label}
      </Text>
      <Text color={value === '—' ? 'ink3' : 'ink'} fontWeight="600">
        {value}
      </Text>
    </Flex>
  );
}

function fmtCny(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  const yi = n / 1e8;
  if (Math.abs(yi) >= 1) return `${yi.toFixed(2)}亿`;
  const wan = n / 1e4;
  if (Math.abs(wan) >= 1) return `${wan.toFixed(2)}万`;
  return n.toFixed(2);
}

function fmtNum(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function fmtPct(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function fmtShare(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  const yi = n / 1e8;
  if (Math.abs(yi) >= 1) return `${yi.toFixed(2)}亿股`;
  const wan = n / 1e4;
  if (Math.abs(wan) >= 1) return `${wan.toFixed(2)}万股`;
  return `${n.toFixed(0)}股`;
}
