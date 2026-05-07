'use client';

/**
 * 105 — Pattern match.
 *
 * Reads the chart-range selection (set by shift-drag in the 101 chart)
 * and runs a similarity scan: for each non-reference stock, look at
 * its most recent 30 trading days and find sub-windows whose shape
 * AND period return match the reference. Each match renders as a row
 * with a 90D inline kline (reusing EQ.CHART's canvas in read-only
 * mode) with the matched window highlighted, plus the combined
 * similarity score and the candidate's period return.
 *
 * Rows are non-interactive — no click callback, no hover state. The
 * match table is purely informational.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { PatternFindSimilarResponse, PatternMatch } from '@quant/shared';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { findSimilarPatterns } from '../../lib/api/endpoints.js';
import { DEFAULT_VIEWPORT } from '../../lib/fp/chart-view.js';
import { useKline } from '../../lib/hooks/use-eqty-data.js';
import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { ChartCanvas, findRangeIndices } from '../feat-eq-chart/chart-canvas.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewHeaderRight } from '../feat-view/feat-view-header.js';
import { MonoButton } from '../ui/mono-button.js';

// Inline-row chart height — tall enough that the candle bodies and
// the highlight rect read clearly. Volume sub-pane is suppressed.
const ROW_PRICE_H = 120;

export function FeatScrPat(): React.ReactElement {
  const range = useUiStore((s) => s.chartRange);
  const setChartRange = useUiStore((s) => s.setChartRange);

  const featViewMode = useLayoutStore((s) => s.featViewMode[Feat.ScreenPattern]);
  const setFeatViewMode = useLayoutStore((s) => s.setFeatViewMode);
  useEffect(() => {
    if (range !== null && featViewMode === 'minimized') {
      setFeatViewMode(Feat.ScreenPattern, 'normal');
    }
  }, [range, featViewMode, setFeatViewMode]);

  const mutation = useMutation<PatternFindSimilarResponse, Error, void>({
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

  const tone = mutation.isPending
    ? 'amber'
    : mutation.isError
      ? 'red'
      : mutation.data !== undefined
        ? 'green'
        : 'idle';

  const right = (
    <FeatViewHeaderRight>
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
    </FeatViewHeaderRight>
  );

  return (
    <FeatView
      feat={Feat.ScreenPattern}
      status={tone}
      statusBlink={mutation.isPending}
      right={right}
    >
      <Box flex="1" bg="panel" overflowY="auto">
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
      bg="panel3"
      borderBottomWidth="1px"
      borderColor="line"
      gap="14px"
      align="baseline"
      fontFamily="mono"
      fontSize="10px"
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
    <Flex align="stretch" gap="12px" px="14px" py="8px" borderBottomWidth="1px" borderColor="line2">
      <Box minW="120px" pt="2px">
        <Text fontFamily="mono" fontSize="12px" color="ink" fontWeight="600">
          {match.name === '' ? match.code : match.name}
        </Text>
        <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.06em">
          {match.code}
        </Text>
      </Box>
      <Box flex="1" minW={0}>
        {bars.length === 0 ? (
          <Text fontFamily="mono" fontSize="10px" color="ink3">
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
        <Text fontFamily="mono" fontSize="10px" color="ink3">
          {match.startDate} → {match.endDate}
        </Text>
        <Flex justify="flex-end" gap="10px" mt="2px">
          <Text fontFamily="mono" fontSize="11px" color="accent" fontWeight="700">
            S={match.similarity.toFixed(2)}
          </Text>
          <Text
            fontFamily="mono"
            fontSize="11px"
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
    <Text px="14px" py="14px" fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.12em">
      // {hint}
    </Text>
  );
}
