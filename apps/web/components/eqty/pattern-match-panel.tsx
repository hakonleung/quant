'use client';

/**
 * 105 — Pattern match.
 *
 * Reads the current chart-range selection (set by shift-drag in the
 * 101 chart) and runs a DTW similarity scan against either the active
 * sector's members or the whole universe. Each match renders as a row
 * with its date range, distance, and a 60-day mini-spark sourced from
 * the existing kline cache.
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import type { KlineBar, PatternFindSimilarResponse, PatternMatch } from '@quant/shared';
import { useMutation } from '@tanstack/react-query';

import { Feat } from '../../lib/eqty/feat.js';
import { findSimilarPatterns } from '../../lib/api/endpoints.js';
import { useKline } from '../../lib/hooks/use-eqty-data.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { Pane } from '../shell/pane.js';

export function PatternMatchPanel(): React.ReactElement {
  const range = useUiStore((s) => s.chartRange);
  const setChartRange = useUiStore((s) => s.setChartRange);
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;

  const universe: readonly string[] =
    activeSectorId === ALL_SECTOR_ID || sector === null ? [] : sector.codes;

  const mutation = useMutation<PatternFindSimilarResponse, Error, void>({
    mutationKey: ['pattern.find_similar', range, universe],
    mutationFn: async (): Promise<PatternFindSimilarResponse> => {
      if (range === null) throw new Error('no chart range selected');
      return findSimilarPatterns({
        code: range.code,
        startDate: range.startDate,
        endDate: range.endDate,
        universe: [...universe],
        lookbackDays: 250,
        topN: 20,
      });
    },
  });

  const onFind = (): void => {
    if (range === null || mutation.isPending) return;
    mutation.mutate();
  };

  const status = mutation.isPending ? (
    <Text color="accent">● scanning</Text>
  ) : mutation.isError ? (
    <Text color="up">✘ {mutation.error.message}</Text>
  ) : mutation.data !== undefined ? (
    <Text color="prompt">● {String(mutation.data.matches.length)} hits</Text>
  ) : (
    <Text color="prompt">○ idle</Text>
  );

  const right = (
    <Flex gap="8px" align="center">
      {range === null ? (
        <Text color="ink3">// shift-drag a range on 101 to set reference</Text>
      ) : (
        <Text color="ink2">
          ▎ {range.code} {range.startDate} → {range.endDate}
        </Text>
      )}
      {status}
      {range !== null && (
        <Button
          h="auto"
          px="8px"
          py="3px"
          bg="panel"
          color="ink2"
          borderWidth="1px"
          borderColor="line"
          fontFamily="mono"
          fontSize="10px"
          letterSpacing="0.14em"
          borderRadius="0"
          onClick={(): void => {
            setChartRange(null);
            mutation.reset();
          }}
        >
          CLEAR
        </Button>
      )}
      <Button
        bg="accent"
        color="panel"
        h="auto"
        px="10px"
        py="3px"
        fontFamily="mono"
        fontSize="10px"
        fontWeight="600"
        letterSpacing="0.16em"
        borderRadius="0"
        onClick={onFind}
        loading={mutation.isPending}
        disabled={range === null}
      >
        ⌕ FIND
      </Button>
    </Flex>
  );

  return (
    <Pane feat={Feat.PatternMatch} right={right}>
      <Box flex="1" overflow="auto" bg="panel">
        {mutation.data === undefined ? (
          <Empty hint={range === null ? 'no reference range' : 'press FIND to scan'} />
        ) : mutation.data.matches.length === 0 ? (
          <Empty hint="no similar patterns found" />
        ) : (
          mutation.data.matches.map((m) => <MatchRow key={`${m.code}-${m.startDate}`} match={m} />)
        )}
      </Box>
    </Pane>
  );
}

function MatchRow({ match }: { match: PatternMatch }): React.ReactElement {
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const { data } = useKline(match.code, '90D');
  const slice = sliceBetween(data ?? [], match.startDate, match.endDate);
  return (
    <Flex
      align="center"
      gap="10px"
      px="14px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="line2"
      cursor="pointer"
      _hover={{ bg: 'hover' }}
      onClick={(): void => {
        setFocusCode(match.code);
      }}
    >
      <Box minW="120px">
        <Text fontFamily="mono" fontSize="12px" color="ink" fontWeight="600">
          {match.name === '' ? match.code : match.name}
        </Text>
        <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.06em">
          {match.code}
        </Text>
      </Box>
      <Box flex="1" minW={0}>
        <Sparkline bars={slice} />
      </Box>
      <Box minW="160px" textAlign="right">
        <Text fontFamily="mono" fontSize="10px" color="ink3">
          {match.startDate} → {match.endDate}
        </Text>
        <Text fontFamily="mono" fontSize="11px" color="accent" fontWeight="700">
          d={match.distance.toFixed(3)}
        </Text>
      </Box>
    </Flex>
  );
}

function Sparkline({ bars }: { bars: readonly KlineBar[] }): React.ReactElement {
  if (bars.length < 2) {
    return (
      <Text fontFamily="mono" fontSize="10px" color="ink3">
        // no kline cached
      </Text>
    );
  }
  const w = 240;
  const h = 36;
  let min = bars[0]!.low;
  let max = bars[0]!.high;
  for (const b of bars) {
    if (b.low < min) min = b.low;
    if (b.high > max) max = b.high;
  }
  const range = max - min || 1;
  const stride = w / Math.max(1, bars.length - 1);
  let path = '';
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i]!;
    const x = i * stride;
    const y = h - ((b.close - min) / range) * h;
    path += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  }
  const color =
    bars[bars.length - 1]!.close >= bars[0]!.close ? 'rgb(201,48,63)' : 'rgb(18,122,85)';
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

function sliceBetween(
  bars: readonly KlineBar[],
  startDate: string,
  endDate: string,
): readonly KlineBar[] {
  const out: KlineBar[] = [];
  for (const b of bars) {
    if (b.date >= startDate && b.date <= endDate) out.push(b);
  }
  return out;
}

function Empty({ hint }: { hint: string }): React.ReactElement {
  return (
    <Text px="14px" py="14px" fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.12em">
      // {hint}
    </Text>
  );
}
