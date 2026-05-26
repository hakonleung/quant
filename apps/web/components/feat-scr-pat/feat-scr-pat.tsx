'use client';

/**
 * PAT — pattern-match floating tile.
 *
 * Reads `chartRange` from `useUiStore` (set by shift-drag in EQ.CHART)
 * and exposes a `find similar` action; results render as one row per
 * match with an inline 50D kline (read-only ChartCanvas).
 *
 * Lives in the same column as EQ.CHART / EQ.INFO so the user can
 * minimize the chart while keeping the matches visible (or vice
 * versa) — that's why the find-similar trigger reads the range from
 * the store rather than via prop drilling.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { PatternFindSimilarResponse, PatternMatch } from '@quant/shared';
import { useMutation } from '@tanstack/react-query';

import { findSimilarPatterns } from '../../lib/api/endpoints.js';
import { Feat } from '../../lib/eqty/feat.js';
import { DEFAULT_VIEWPORT } from '../../lib/fp/chart-view.js';
import { useKline } from '../../lib/hooks/use-eqty-data.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { ChartCanvas, findRangeIndices } from '../feat-eq-chart/chart-canvas.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';

const ROW_PRICE_H = 120;

export function FeatScrPat(): React.ReactElement {
  const range = useUiStore((s) => s.chartRange);
  const setChartRange = useUiStore((s) => s.setChartRange);

  const mutation = useMutation<PatternFindSimilarResponse>({
    mutationKey: ['pattern.find_similar', range],
    mutationFn: async (): Promise<PatternFindSimilarResponse> => {
      if (range === null) throw new Error('no chart range selected');
      return findSimilarPatterns({
        code: range.code,
        startDate: range.startDate,
        endDate: range.endDate,
        topN: 20,
      });
    },
  });

  const onFind = (): void => {
    if (range === null || mutation.isPending) return;
    mutation.mutate();
  };

  const tone = mutation.isError ? 'red' : mutation.isPending ? 'amber' : 'green';

  return (
    <FeatView
      feat={Feat.ScreenPattern}
      status={tone}
      statusBlink={mutation.isPending}
      titleSlot={
        <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.10em">
          {range === null
            ? '// shift-drag in EQ to pick a reference range'
            : `${range.startDate} → ${range.endDate}`}
        </Text>
      }
      right={
        <>
          {range !== null && (
            <MonoButton
              icon="delete"
              label="clear range"
              onClick={(): void => {
                setChartRange(null);
                mutation.reset();
              }}
            />
          )}
          <MonoButton
            icon="search"
            label={range === null ? 'no range selected' : 'find similar'}
            onClick={onFind}
            disabled={range === null || mutation.isPending}
          />
        </>
      }
    >
      <Box>
        {mutation.data === undefined ? (
          <Empty hint={range === null ? 'no reference range' : 'press FIND to scan'} />
        ) : mutation.data.matches.length === 0 ? (
          <Empty hint="no similar patterns found" />
        ) : (
          <>
            <RefBanner data={mutation.data} />
            {mutation.data.matches.map((m) => (
              <MatchRow key={`${m.code}-${m.startDate}`} match={m} />
            ))}
          </>
        )}
      </Box>
    </FeatView>
  );
}

function RefBanner({ data }: { data: PatternFindSimilarResponse }): React.ReactElement {
  return (
    <Flex
      px="14px"
      py="6px"
      bg="glass.panelSoft"
      backdropFilter="blur(12px)"
      borderBottomWidth="1px"
      borderColor="glass.line"
      gap="14px"
      align="baseline"
      fontFamily="mono"
      fontSize="xs"
      color="ink3"
      letterSpacing="0.10em"
    >
      <Text>
        REF{' '}
        <Text as="span" color="ink" fontWeight="700">
          {data.referenceCode}
        </Text>
      </Text>
      <Text>
        {data.referenceStart} → {data.referenceEnd} · {data.windowDays}d
      </Text>
      <Text>
        REF RET{' '}
        <Text as="span" color={data.referencePeriodReturn >= 0 ? 'up' : 'down'} fontWeight="700">
          {formatPct(data.referencePeriodReturn)}
        </Text>
      </Text>
    </Flex>
  );
}

function MatchRow({ match }: { match: PatternMatch }): React.ReactElement {
  const { data } = useKline(match.code, '50D');
  const bars = data ?? [];
  const highlight = findRangeIndices(bars, match.startDate, match.endDate);
  return (
    <Flex
      align="stretch"
      gap="12px"
      px="14px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="glass.line"
    >
      <Box minW="120px" pt="2px">
        <Text fontFamily="mono" fontSize="sm" color="ink" fontWeight="600">
          {match.name === '' ? match.code : match.name}
        </Text>
        <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.06em">
          {match.code}
        </Text>
      </Box>
      <Box flex="1" minW={0}>
        {bars.length === 0 ? (
          <Text fontFamily="mono" fontSize="xs" color="ink3">
            // no kline cached
          </Text>
        ) : (
          <ChartCanvas
            bars={bars}
            vp={DEFAULT_VIEWPORT}
            setVp={NOOP_SET_VP}
            committedRange={highlight}
            interactive={false}
            priceH={ROW_PRICE_H}
            volH={0}
            showPriceAxis={false}
            showDateAxis={false}
            showVolume={false}
          />
        )}
      </Box>
      <Box minW="170px" textAlign="right" pt="2px">
        <Text fontFamily="mono" fontSize="xs" color="ink3">
          {match.startDate} → {match.endDate}
        </Text>
        <Flex justify="flex-end" gap="10px" mt="2px">
          <Text fontFamily="mono" fontSize="xs" color="accent" fontWeight="700">
            S={match.similarity.toFixed(2)}
          </Text>
          <Text
            fontFamily="mono"
            fontSize="xs"
            fontWeight="700"
            color={match.periodReturn >= 0 ? 'up' : 'down'}
          >
            {formatPct(match.periodReturn)}
          </Text>
        </Flex>
      </Box>
    </Flex>
  );
}

const NOOP_SET_VP = (): void => {
  /* read-only chart — viewport never changes */
};

function formatPct(v: number): string {
  const pct = v * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function Empty({ hint }: { hint: string }): React.ReactElement {
  return (
    <Text px="14px" py="14px" fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.12em">
      // {hint}
    </Text>
  );
}
