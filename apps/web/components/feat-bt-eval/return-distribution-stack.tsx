'use client';

/**
 * Vertically-stacked return-distribution charts, one per holding.
 *
 * Computes the shared x-domain across every holding's observation set
 * (with light symmetric padding) so panels are visually comparable, and
 * delegates the per-panel rendering to {@link ReturnDistributionChart}.
 */

import { Box, Flex } from '@chakra-ui/react';
import type {
  BacktestEvaluateResponse,
  BacktestObservation,
  BacktestSpreadSummary,
} from '@quant/shared';
import { useMemo } from 'react';

import { ReturnDistributionChart } from './return-distribution-chart.js';
import { KDE_COLOR, REF_COLORS } from './return-distribution-pieces.js';

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
      <Legend />
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
          />
        );
      })}
    </Flex>
  );
}

function Legend(): React.ReactElement {
  const items: readonly { color: string; label: string; dashed: boolean }[] = [
    { color: REF_COLORS.zero, label: '0%', dashed: true },
    { color: REF_COLORS.mean, label: '均值', dashed: false },
    { color: REF_COLORS.median, label: '中位', dashed: true },
    { color: REF_COLORS.baseline, label: '基准', dashed: true },
    { color: KDE_COLOR, label: 'KDE 平滑曲线', dashed: false },
  ];
  return (
    <Flex gap="10px" fontFamily="mono" fontSize="10px" color="ink3" flexWrap="wrap">
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
