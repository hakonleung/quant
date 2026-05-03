'use client';

/**
 * 104 — Sector sentiment.
 *
 * Mirrors 103 stdout, but operates on the active sector's member codes
 * via analyze_many. Cached read (useMarketSentiment) is the default
 * render path; the FETCH button fires the LLM-backed analyze_many
 * mutation.
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';

import { Feat } from '../../lib/eqty/feat.js';
import { useAnalyzeMany, useMarketSentiment } from '../../lib/hooks/use-eqty-data.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { Pane } from '../shell/pane.js';
import { ANALYZE_MAX_CODES } from './sectors-panel.js';

export function SectorSentimentPanel(): React.ReactElement | null {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const codes = sector?.codes ?? [];
  const cached = useMarketSentiment(codes);
  const analyze = useAnalyzeMany(codes);
  const data = cached.data ?? null;

  const tooLarge = codes.length > ANALYZE_MAX_CODES;
  const onFetch = (): void => {
    if (codes.length === 0 || analyze.isPending || tooLarge) return;
    analyze.mutate();
  };

  const status = analyze.isPending ? (
    <Text color="accent">● analyzing</Text>
  ) : analyze.isError ? (
    <Text color="up">✘ {analyze.error.message}</Text>
  ) : data === null ? (
    <Text color="prompt">○ idle</Text>
  ) : (
    <Text color="prompt">● cached</Text>
  );

  const sectorLabel =
    sector === null
      ? '(no sector selected)'
      : activeSectorId === ALL_SECTOR_ID
        ? 'All'
        : sector.name;

  const lines: readonly string[] =
    data === null
      ? [
          `$ sentiment.analyze_many --sector ${sectorLabel} --members ${String(codes.length)}`,
          codes.length === 0 ? '// no members' : '// awaiting trigger',
        ]
      : [
          `$ sentiment.analyze_many --asof ${data.asof} --window ${String(data.windowDays)}d`,
          `▎ members ${String(data.codes.length)}  themes ${String(data.themeClusters.length)}`,
          ...data.themeClusters.map(
            (t) =>
              `  · ${t.label} [${String(t.memberCount)}m heat=${t.heatScore.toFixed(2)}] ${t.summary}`,
          ),
          '',
          '▎ trend',
          `  ${data.marketTrendSummary}`,
          ...(data.caveats.length === 0
            ? []
            : ['', '▎ caveats', ...data.caveats.map((c) => `  ! ${c}`)]),
        ];

  return (
    <Pane
      feat={Feat.Insights}
      right={
        <Flex gap="8px" align="center">
          <Text color="ink3">▎ {sectorLabel}</Text>
          {status}
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
            onClick={onFetch}
            loading={analyze.isPending}
            disabled={codes.length === 0 || tooLarge}
            title={
              tooLarge
                ? `too many members (${String(codes.length)} > ${String(ANALYZE_MAX_CODES)})`
                : undefined
            }
          >
            ⟳ FETCH
          </Button>
        </Flex>
      }
    >
      <Box
        position="relative"
        px="18px"
        py="14px"
        bg="term.panel"
        color="term.ink2"
        fontFamily="mono"
        fontSize="12px"
        lineHeight="1.7"
        h="100%"
        overflow="auto"
      >
        {lines.map((line, i) => (
          <Flex key={i} gap="10px">
            <Text color="term.ink3" minW="34px" textAlign="right" fontSize="11px" userSelect="none">
              {String(i + 1).padStart(3, '0')}
            </Text>
            <Text color="term.ink2">{line === '' ? ' ' : line}</Text>
          </Flex>
        ))}
      </Box>
    </Pane>
  );
}
