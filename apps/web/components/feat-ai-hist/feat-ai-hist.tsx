'use client';

/**
 * 104 — Sector sentiment.
 *
 * Mirrors 103 stdout, but operates on the active sector's member codes
 * via analyze_many. Cached read (useMarketSentiment) is the default
 * render path; the FETCH button fires the LLM-backed analyze_many
 * mutation behind a confirm guard (paid call).
 */

import { Box, Flex, Text } from '@chakra-ui/react';

import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { useAnalyzeMany, useMarketSentiment } from '../../lib/hooks/use-eqty-data.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from "../feat-view/feat-view.js";
import { FeatViewAction, FeatViewHeaderRight, FeatViewStatus } from "../feat-view/feat-view-header.js";
import { ANALYZE_MAX_CODES } from "../feat-sec-list/feat-sec-list.js";

export function FeatAiHist(): React.ReactElement | null {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const codes = sector?.codes ?? [];
  const cached = useMarketSentiment(codes);
  const analyze = useAnalyzeMany(codes);
  const data = cached.data ?? null;
  const { guard, comp: confirmComp } = useConfirm();

  const tooLarge = codes.length > ANALYZE_MAX_CODES;

  const sectorLabel =
    sector === null ? '-' : activeSectorId === ALL_SECTOR_ID ? 'All' : sector.name;

  const onFetch = (): void => {
    if (codes.length === 0 || analyze.isPending || tooLarge) return;
    guard({
      title: 'confirm analyze_many',
      message: (
        <>
          <Text fontFamily="mono" fontSize="12px" color="ink2" lineHeight="1.7">
            sentiment.analyze_many is a high-cost LLM job.
          </Text>
          <Text fontFamily="mono" fontSize="12px" color="ink2" lineHeight="1.7" mt="8px">
            sector{' '}
            <Text as="span" color="accent">
              {sectorLabel}
            </Text>{' '}
            · members{' '}
            <Text as="span" color="accent">
              {String(codes.length)}
            </Text>
          </Text>
          <Text fontFamily="mono" fontSize="11px" color="ink3" mt="10px">
            // each call burns paid LLM tokens. proceed?
          </Text>
        </>
      ),
      confirmLabel: 'CONFIRM ⟳',
    })
      .then(() => {
        analyze.mutate();
      })
      .catch((e: unknown) => {
        if (e instanceof ConfirmCancelled) return;
        throw e;
      });
  };

  const tone = analyze.isPending
    ? 'amber'
    : analyze.isError
      ? 'red'
      : data === null
        ? 'idle'
        : 'green';

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
    <FeatView
      feat={Feat.AIHist}
      right={
        <FeatViewHeaderRight>
          <FeatViewStatus tone={tone} blink={analyze.isPending} />
          <FeatViewAction
            title={
              tooLarge
                ? `too many members (${String(codes.length)} > ${String(ANALYZE_MAX_CODES)})`
                : `analyze ${sectorLabel}`
            }
            onClick={onFetch}
            busy={analyze.isPending}
            disabled={codes.length === 0 || tooLarge}
            tone="accent"
          >
            ⟳
          </FeatViewAction>
        </FeatViewHeaderRight>
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
      >
        {lines.map((line, i) => (
          <Flex key={i} gap="10px">
            <Text color="term.ink3" minW="34px" textAlign="right" fontSize="11px" userSelect="none">
              {String(i + 1).padStart(3, '0')}
            </Text>
            <Text color="term.ink2">{line === '' ? ' ' : line}</Text>
          </Flex>
        ))}
      </Box>
      {confirmComp}
    </FeatView>
  );
}
