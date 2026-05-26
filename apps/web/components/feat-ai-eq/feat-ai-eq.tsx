'use client';

/**
 * AI.EQ — Single-stock LLM sentiment.
 *
 * Body is the shared `TermConsole`. We wait for the cache-only query
 * (`useSentiment`) to settle, then mount the term with either:
 *   - `initialOutput`  — cached `sentimentLines()` baked into a single
 *                        `[cached]` history entry (no LLM call), or
 *   - `initialBuffer`  — `analyze code=<code> fresh=1` pre-filled at the
 *                        prompt so a single Enter triggers the paid
 *                        fetch via the term cell's confirm-required
 *                        flow.
 * FETCH and push-to-slack live in the header; FETCH forces the same
 * `… fresh=1` command via the ref.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { sentimentLines } from '@quant/shared';
import type { TerminalState } from '@quant/terminal';
import { useMemo, useRef, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useSentiment, useStockMetaQuery } from '../../lib/hooks/use-eqty-data.js';
import { usePushPayload } from '../../lib/hooks/use-push-payload.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewHeaderRight } from '../feat-view/feat-view-header.js';
import {
  TermConsole,
  type InitialOutput,
  type TermConsoleHandle,
} from '../term-console/index.js';
import { MonoButton } from '../ui/mono-button.js';

interface Props {
  readonly code: string;
}

export function FeatAiEq({ code }: Props): React.ReactElement {
  const cached = useSentiment(code);
  const meta = useStockMetaQuery(code);
  const push = usePushPayload();
  const termRef = useRef<TermConsoleHandle>(null);
  const [phase, setPhase] = useState<TerminalState['phase']>('idle');
  const sentiment = cached.data ?? null;
  const stockLabel =
    meta.data !== null && meta.data !== undefined ? `${meta.data.name} ${code}` : code;

  const initialOutput: InitialOutput | undefined = useMemo(() => {
    if (sentiment === null) return undefined;
    const d = new Date(sentiment.cachedAt);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const cacheLocal = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const head = `$ analyze code=${code}  cache=${cacheLocal}`;
    const body = `${head}\n${sentimentLines(sentiment).join('\n')}`;
    return { body, status: 'cached' };
  }, [sentiment, code]);

  const onFetch = (): void => {
    termRef.current?.runCommand(`analyze code=${code} fresh=1`);
  };

  const onPush = (): void => {
    if (sentiment === null) return;
    const head = `[${stockLabel}] sent ${sentiment.score.toFixed(2)}`;
    const briefBlock = sentiment.brief.length > 0 ? `\n\n${sentiment.brief}` : '';
    const body = sentimentLines(sentiment).join('\n');
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
        : sentiment === null
          ? 'idle'
          : 'green';

  return (
    <FeatView
      feat={Feat.AIEq}
      status={tone}
      statusBlink={isRunning || push.isPending}
      titleSlot={
        <Text
          fontFamily="mono"
          fontSize="xs"
          letterSpacing="0.06em"
          color="term.ink2"
          whiteSpace="nowrap"
        >
          {stockLabel}
        </Text>
      }
      right={
        <FeatViewHeaderRight>
          <MonoButton icon="refresh" label="fetch sentiment" onClick={onFetch} disabled={isRunning} />
          <MonoButton
            icon="push"
            label="push sentiment to slack"
            onClick={onPush}
            disabled={sentiment === null || push.isPending}
          />
        </FeatViewHeaderRight>
      }
    >
      <Flex direction="column" h="100%" minH={0}>
        <Box flex="1" minH={0}>
          {cached.isFetched && (
            <TermConsole
              ref={termRef}
              key={code}
              fontSize={12}
              showLineNumbers
              banner=""
              {...(initialOutput !== undefined
                ? { initialOutput }
                : { initialBuffer: `analyze code=${code} fresh=1` })}
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
