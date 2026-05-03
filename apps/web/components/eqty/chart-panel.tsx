'use client';

import { Box, Button, Flex, HStack, Text } from '@chakra-ui/react';
import type { KlineBar } from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';

import { buildLayout, buildMaPath, pctChangeToLatest, type MaKey } from '../../lib/fp/kline-chart.js';
import { useKline } from '../../lib/hooks/use-eqty-data.js';
import { palette } from '../../lib/theme/tokens.js';
import { Pane } from '../shell/pane.js';

const RANGES = ['30D', '90D', '250D'] as const;
type Range = (typeof RANGES)[number];

const MA_COLORS: Readonly<Record<MaKey, string>> = {
  ma5: palette.light.amber,
  ma10: palette.light.violet,
  ma20: palette.light.blue,
  ma60: palette.light.green,
};

const CHART_VIEW_W = 1080;
const PRICE_VIEW_H = 240;
const VOL_VIEW_H = 80;
const VOL_GAP = 4;

interface Props {
  readonly code: string;
}

export function ChartPanel({ code }: Props): React.ReactElement {
  const [range, setRange] = useState<Range>('90D');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const { data, isLoading } = useKline(code, range);
  const bars = data ?? [];

  const barsKey = bars.length === 0 ? '' : `${bars[0]!.date}-${bars[bars.length - 1]!.date}`;
  useEffect(() => {
    setSelectedIdx(null);
  }, [barsKey]);

  const focusBar = selectedIdx === null ? bars[bars.length - 1] : bars[selectedIdx];
  const focusIdx = focusBar === undefined ? null : selectedIdx ?? bars.length - 1;
  const deltaPct = focusIdx === null ? null : pctChangeToLatest(bars, focusIdx);

  return (
    <Pane id="110" title="Price Chart · D · MA{5,10,20,60}" gridArea="CMID" right={<Text>tz:Asia/Shanghai</Text>}>
      <ChartTools range={range} setRange={setRange} />
      <FocusLabel bar={focusBar ?? null} deltaPct={deltaPct} selected={selectedIdx !== null} />
      <Box position="relative" h={`${String(PRICE_VIEW_H + VOL_VIEW_H + VOL_GAP)}px`} bg="panel">
        {isLoading ? (
          <Centered>loading kline…</Centered>
        ) : bars.length === 0 ? (
          <Centered>// no kline data</Centered>
        ) : (
          <ChartSvg
            bars={bars}
            selectedIdx={selectedIdx}
            onSelect={(idx): void => {
              setSelectedIdx((prev) => (prev === idx ? null : idx));
            }}
          />
        )}
      </Box>
    </Pane>
  );
}

interface ChartSvgProps {
  readonly bars: readonly KlineBar[];
  readonly selectedIdx: number | null;
  readonly onSelect: (idx: number) => void;
}

function ChartSvg({ bars, selectedIdx, onSelect }: ChartSvgProps): React.ReactElement {
  const { layout, scaleY } = useMemo(() => buildLayout(bars), [bars]);
  const ma5 = useMemo(() => buildMaPath(bars, 'ma5', scaleY), [bars, scaleY]);
  const ma10 = useMemo(() => buildMaPath(bars, 'ma10', scaleY), [bars, scaleY]);
  const ma20 = useMemo(() => buildMaPath(bars, 'ma20', scaleY), [bars, scaleY]);
  const ma60 = useMemo(() => buildMaPath(bars, 'ma60', scaleY), [bars, scaleY]);
  const volScale = useMemo(() => buildVolumeScale(bars), [bars]);
  const totalH = PRICE_VIEW_H + VOL_GAP + VOL_VIEW_H;

  return (
    <Box
      as="svg"
      display="block"
      w="100%"
      h={`${String(totalH)}px`}
      cursor="crosshair"
      {...{ viewBox: `0 0 ${String(CHART_VIEW_W)} ${String(totalH)}`, preserveAspectRatio: 'none' }}
    >
      <defs>
        <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M60 0H0V60" fill="none" stroke={palette.light.line2} />
        </pattern>
      </defs>

      {/* Price area */}
      <rect width={CHART_VIEW_W} height={PRICE_VIEW_H} fill="url(#grid)" />
      {layout.map((c, i) => {
        const col = c.up ? palette.light.up : palette.light.down;
        const isSel = selectedIdx === i;
        return (
          <g
            key={i}
            onClick={(): void => {
              onSelect(i);
            }}
            style={{ cursor: 'pointer' }}
          >
            <rect
              x={c.x - 2}
              y={0}
              width={14}
              height={totalH}
              fill={isSel ? 'rgba(184,117,20,0.10)' : 'transparent'}
            />
            <line x1={c.x + 5} x2={c.x + 5} y1={c.highY} y2={c.lowY} stroke={col} />
            <rect x={c.x} y={c.bodyY} width="10" height={c.bodyH} fill={col} />
            {isSel && (
              <line
                x1={c.x + 5}
                x2={c.x + 5}
                y1={0}
                y2={totalH}
                stroke={palette.light.amber}
                strokeDasharray="2 3"
                opacity="0.7"
              />
            )}
          </g>
        );
      })}
      {ma5 !== null && <path d={ma5} fill="none" stroke={MA_COLORS.ma5} strokeWidth="1.2" />}
      {ma10 !== null && <path d={ma10} fill="none" stroke={MA_COLORS.ma10} strokeWidth="1.2" />}
      {ma20 !== null && <path d={ma20} fill="none" stroke={MA_COLORS.ma20} strokeWidth="1.2" />}
      {ma60 !== null && <path d={ma60} fill="none" stroke={MA_COLORS.ma60} strokeWidth="1.2" />}

      {/* Volume area */}
      <line
        x1={0}
        x2={CHART_VIEW_W}
        y1={PRICE_VIEW_H}
        y2={PRICE_VIEW_H}
        stroke={palette.light.line}
        strokeWidth="1"
      />
      <text
        x={6}
        y={PRICE_VIEW_H + 12}
        fontSize="10"
        fontFamily="JetBrains Mono"
        fill={palette.light.ink3}
        letterSpacing="0.16em"
      >
        VOL
      </text>
      {bars.map((b, i) => {
        const c = layout[i];
        if (c === undefined) return null;
        const h = volScale(b.volume);
        const y = PRICE_VIEW_H + VOL_GAP + (VOL_VIEW_H - h);
        const col = b.close >= b.open ? palette.light.up : palette.light.down;
        return (
          <rect
            key={i}
            x={c.x}
            y={y}
            width="10"
            height={Math.max(1, h)}
            fill={col}
            opacity={selectedIdx === null || selectedIdx === i ? 0.85 : 0.35}
          />
        );
      })}
    </Box>
  );
}

function buildVolumeScale(bars: readonly KlineBar[]): (volume: number) => number {
  if (bars.length === 0) return () => 0;
  let max = 0;
  for (const b of bars) {
    if (b.volume > max) max = b.volume;
  }
  if (max === 0) return () => 0;
  return (volume: number): number => (volume / max) * (VOL_VIEW_H - 8);
}

interface FocusProps {
  readonly bar: KlineBar | null;
  readonly deltaPct: number | null;
  readonly selected: boolean;
}

function FocusLabel({ bar, deltaPct, selected }: FocusProps): React.ReactElement {
  if (bar === null) {
    return (
      <Box px="14px" py="4px" borderBottomWidth="1px" borderColor="line" bg="panel3">
        <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.12em">
          // no bar
        </Text>
      </Box>
    );
  }
  return (
    <Flex
      px="14px"
      py="4px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      align="center"
      gap="10px"
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
        {selected ? `SEL ${bar.date}` : `LATEST ${bar.date}`}
      </Box>
      <Stat label="O" value={bar.open.toFixed(2)} />
      <Stat label="H" value={bar.high.toFixed(2)} color="up" />
      <Stat label="L" value={bar.low.toFixed(2)} color="down" />
      <Stat label="换手" value={`${(bar.turnoverRate * 100).toFixed(2)}%`} />
      {deltaPct !== null && (
        <Stat
          label="距今"
          value={`${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`}
          color={deltaPct >= 0 ? 'up' : 'down'}
          bold
        />
      )}
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

function MaInline({ ma, value, color }: { ma: string; value: number | null; color: string }): React.ReactElement {
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
  readonly range: Range;
  readonly setRange: (r: Range) => void;
}

function ChartTools({ range, setRange }: ToolsProps): React.ReactElement {
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
      {RANGES.map((r) => (
        <ToolButton
          key={r}
          active={r === range}
          onClick={(): void => {
            setRange(r);
          }}
        >
          {r}
        </ToolButton>
      ))}
      <Text ml="14px">STUDIES:</Text>
      <ToolButton active>MA5</ToolButton>
      <ToolButton active>MA10</ToolButton>
      <ToolButton active>MA20</ToolButton>
      <ToolButton active>MA60</ToolButton>
      <HStack ml="auto" gap="14px">
        <Text>CLICK→Δ%</Text>
      </HStack>
    </Flex>
  );
}

interface ButtonProps {
  readonly children: React.ReactNode;
  readonly active?: boolean;
  readonly onClick?: () => void;
}

function ToolButton({ children, active = false, onClick }: ButtonProps): React.ReactElement {
  return (
    <Button
      h="auto"
      px="8px"
      py="3px"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.14em"
      textTransform="uppercase"
      bg={active ? 'accentBg' : 'panel'}
      color={active ? 'accent' : 'ink2'}
      borderWidth="1px"
      borderColor={active ? 'accent' : 'line'}
      borderRadius="0"
      fontWeight={active ? '700' : '500'}
      onClick={onClick}
      _hover={active ? {} : { bg: 'hover' }}
    >
      {children}
    </Button>
  );
}
