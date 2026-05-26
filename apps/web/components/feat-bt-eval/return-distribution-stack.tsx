'use client';

/**
 * Vertically-stacked return-distribution charts, one per holding.
 *
 * Computes the shared x-domain across every holding's observation set
 * (with light symmetric padding) so panels are visually comparable, and
 * delegates the per-panel rendering to {@link ReturnDistributionChart}.
 *
 * Owns the single `useTokenColors` call that resolves every `dist.*`
 * semantic token; the resulting `DistColors` struct is passed to the
 * legend and each chart so SVG / Canvas leaves never read CSS vars
 * themselves.
 */

import { Box, Flex } from '@chakra-ui/react';
import type {
  BacktestEvaluateResponse,
  BacktestObservation,
  BacktestSpreadSummary,
} from '@quant/shared';
import { useMemo } from 'react';

import { useTokenColors } from '../../lib/theme/use-token-color.js';

import { ReturnDistributionChart } from './return-distribution-chart.js';
import type { DistColors } from './return-distribution-pieces.js';

export interface ReturnDistributionStackProps {
  readonly summary: BacktestEvaluateResponse['summary'];
  readonly observations: readonly BacktestObservation[];
  readonly baselineByHolding: Readonly<Record<number, number>>;
  readonly spreadByHolding: Readonly<Record<number, BacktestSpreadSummary>>;
  readonly width?: number;
  readonly height?: number;
}

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 140;
const DOMAIN_PAD = 0.05;

/**
 * Token paths consumed by {@link DistColors}, in the order required
 * by {@link buildDistColors}.
 */
// Folded in task #10: every dist-chart reference line now reuses
// the kline-chart MA palette so the two charts feel like part of
// the same family. Same mapping the user sees on the candle chart:
//   stat.zero      → ink3   (neutral baseline)
//   stat.mean      → violet (= MA20)
//   stat.median    → link   (= MA5)
//   stat.baseline  → accent (= MA10)
// bar.fill stays `ink2` + SVG `fillOpacity={0.35}` (see task #8).
const DIST_COLOR_PATHS = [
  'ink3',
  'violet',
  'link',
  'accent',
  'ink2',
  'ink2',
  'link',
  'line',
  'ink3',
  'ink3',
  'ink',
  'ink3',
] as const;

function buildDistColors(resolved: readonly string[]): DistColors {
  const at = (i: number): string => resolved[i] ?? '';
  return {
    zero: at(0),
    mean: at(1),
    median: at(2),
    baseline: at(3),
    kdeLine: at(4),
    barFill: at(5),
    barStroke: at(6),
    axisLine: at(7),
    axisTick: at(8),
    axisLabel: at(9),
    crosshair: at(10),
    emptyText: at(11),
  };
}

export function ReturnDistributionStack(
  props: ReturnDistributionStackProps,
): React.ReactElement {
  const {
    summary,
    observations,
    baselineByHolding,
    spreadByHolding,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
  } = props;

  const tokens = useTokenColors(DIST_COLOR_PATHS);
  const colors = useMemo(() => buildDistColors(tokens), [tokens]);

  const domain = useMemo(() => computeSharedDomain(observations), [observations]);

  const byHolding = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const o of observations) {
      const arr = map.get(o.holding) ?? [];
      arr.push(o.ret);
      map.set(o.holding, arr);
    }
    return map;
  }, [observations]);

  return (
    <Flex direction="column" gap="10px">
      <Legend colors={colors} />
      {summary.map((s) => {
        const rets = byHolding.get(s.holding) ?? [];
        const spread = spreadByHolding[s.holding] ?? null;
        const baseline = baselineByHolding[s.holding] ?? null;
        return (
          <ReturnDistributionChart
            key={s.holding}
            holding={s.holding}
            returns={rets}
            domainMin={domain.min}
            domainMax={domain.max}
            mean={s.mean}
            median={s.median}
            baseline={baseline}
            summaryLine={buildSummaryLine(s, spread)}
            width={width}
            height={height}
            colors={colors}
          />
        );
      })}
    </Flex>
  );
}

function Legend({ colors }: { readonly colors: DistColors }): React.ReactElement {
  const items: readonly { color: string; label: string; dashed: boolean }[] = [
    { color: colors.zero, label: '0%', dashed: true },
    { color: colors.mean, label: '均值', dashed: false },
    { color: colors.median, label: '中位', dashed: true },
    { color: colors.baseline, label: '基准', dashed: true },
    { color: colors.kdeLine, label: 'KDE 平滑曲线', dashed: false },
  ];
  return (
    <Flex gap="10px" fontFamily="mono" fontSize="xs" color="ink3" flexWrap="wrap">
      {items.map((it) => (
        <Flex key={it.label} align="center" gap="4px">
          <Box
            as="span"
            w="14px"
            h="0"
            borderTop="2px"
            borderTopStyle={it.dashed ? 'dashed' : 'solid'}
            borderColor={it.color}
          />
          <Box as="span">{it.label}</Box>
        </Flex>
      ))}
    </Flex>
  );
}

interface Domain {
  readonly min: number;
  readonly max: number;
}

function computeSharedDomain(observations: readonly BacktestObservation[]): Domain {
  if (observations.length === 0) return { min: -DOMAIN_PAD, max: DOMAIN_PAD };
  let min = Infinity;
  let max = -Infinity;
  for (const o of observations) {
    if (o.ret < min) min = o.ret;
    if (o.ret > max) max = o.ret;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const c = Number.isFinite(min) ? min : 0;
    return { min: c - DOMAIN_PAD, max: c + DOMAIN_PAD };
  }
  const span = max - min;
  const pad = span * 0.05;
  return { min: min - pad, max: max + pad };
}

function buildSummaryLine(
  s: BacktestEvaluateResponse['summary'][number],
  spread: BacktestSpreadSummary | null,
): string {
  const parts = [
    `持仓 ${String(s.holding)}d`,
    `样本 n=${String(s.n)}`,
    `均值 ${signedPct(s.mean)}`,
    `中位 ${signedPct(s.median)}`,
    `胜率 ${pctInt(s.winRate)}`,
  ];
  if (spread !== null) {
    parts.push(`超额 ${signedPct(spread.spreadMean)} (t=${spread.spreadTStat.toFixed(2)})`);
  }
  parts.push(`类夏普 ${s.sharpeLike.toFixed(2)}`);
  return parts.join(' · ');
}

function signedPct(v: number): string {
  const pct = v * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function pctInt(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}
