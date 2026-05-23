'use client';

/**
 * AI.SEC — Sector sentiment.
 *
 * Mirrors AI.EQ on the shared `TermConsole`: wait for the cache query
 * to settle, then mount with either a `[cached]` history entry
 * (cache hit) or a pre-filled `analyze.sector id=<id> fresh=1` buffer
 * (cache miss). FETCH forces the same `… fresh=1` command via the
 * ref; the term cell's confirm-required widget handles the paid
 * confirm.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { marketSentimentLines } from '@quant/shared';
import type { TerminalState } from '@quant/terminal';
import { useMemo, useRef, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useMarketSentiment } from '../../lib/hooks/use-eqty-data.js';
import { usePushPayload } from '../../lib/hooks/use-push-payload.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewHeaderRight } from '../feat-view/feat-view-header.js';
import {
  TermConsole,
  type InitialOutput,
  type TermConsoleHandle,
} from '../term-console/index.js';
import { MonoButton } from '../ui/mono-button.js';
import { ANALYZE_MAX_CODES } from '../feat-sec-list/feat-sec-list.js';

export function FeatAiSec(): React.ReactElement | null {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const codes = sector?.codes ?? [];
  const cached = useMarketSentiment(codes);
  const push = usePushPayload();
  const termRef = useRef<TermConsoleHandle>(null);
  const [phase, setPhase] = useState<TerminalState['phase']>('idle');
  const data = cached.data ?? null;

  const tooLarge = codes.length > ANALYZE_MAX_CODES;
  const sectorLabel =
    sector === null ? '-' : activeSectorId === ALL_SECTOR_ID ? 'All' : sector.name;

  const initialOutput: InitialOutput | undefined = useMemo(() => {
    if (data === null) return undefined;
    const head = `$ analyze.sector id=${sector?.id ?? '-'}  asof=${data.asof}  window=${String(data.windowDays)}d  members=${String(data.codes.length)}`;
    const body = `${head}\n${marketSentimentLines(data).join('\n')}`;
    return { body, status: 'cached' };
  }, [data, sector?.id]);

  const onFetch = (): void => {
    if (sector === null || codes.length === 0 || tooLarge) return;
    termRef.current?.runCommand(`analyze.sector id=${sector.id} fresh=1`);
  };

  const onPush = (): void => {
    if (data === null) return;
    const head = `[sector ${sectorLabel}] asof ${data.asof} · window ${String(data.windowDays)}d · members ${String(data.codes.length)}`;
    const briefBlock = data.brief.length > 0 ? `\n\n${data.brief}` : '';
    const body = marketSentimentLines(data).join('\n');
    const composed = `${head}${briefBlock}\n\n${body}`;
    const payload =
      composed.length > 15800 ? `${composed.slice(0, 15800)}\n…[truncated]` : composed;
    push.mutate({ payload });
  };

  const isRunning = phase === 'running' || phase === 'cancelling';
  const tone = isRunning
    ? 'amber'
    : push.isPending
      ? 'amber'
      : push.isError
        ? 'red'
        : data === null
          ? 'idle'
          : 'green';

  const canPrefill = sector !== null && codes.length > 0 && !tooLarge;
  const initialBuffer = canPrefill ? `analyze.sector id=${sector.id} fresh=1` : undefined;

  return (
    <FeatView
      feat={Feat.AISec}
      status={tone}
      statusBlink={isRunning || push.isPending}
      titleSlot={
        <Text
          fontFamily="mono"
          fontSize="11px"
          letterSpacing="0.06em"
          color="term.ink2"
          whiteSpace="nowrap"
        >
          {sectorLabel}
        </Text>
      }
      right={
        <FeatViewHeaderRight>
          <MonoButton
            icon="refresh"
            label={
              tooLarge
                ? `too many members (${String(codes.length)} > ${String(ANALYZE_MAX_CODES)})`
                : `analyze ${sectorLabel}`
            }
            onClick={onFetch}
            disabled={sector === null || codes.length === 0 || tooLarge || isRunning}
          />
          <MonoButton
            icon="push"
            label="push sector summary to slack"
            onClick={onPush}
            disabled={data === null || push.isPending}
          />
        </FeatViewHeaderRight>
      }
    >
      <Flex direction="column" h="100%" minH={0}>
        <Box flex="1" minH={0}>
          {cached.isFetched && (
            <TermConsole
              ref={termRef}
              key={sector?.id ?? '-'}
              fontSize={12}
              showLineNumbers
              banner=""
              {...(initialOutput !== undefined ? { initialOutput } : {})}
              {...(initialOutput === undefined && initialBuffer !== undefined
                ? { initialBuffer }
                : {})}
              onState={(s): void => {
                setPhase(s.phase);
              }}
            />
          )}
        </Box>
      </Flex>
    </FeatView>
  );
}
