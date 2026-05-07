'use client';

import { Box, Flex, Text } from '@chakra-ui/react';

import { Feat } from '../../lib/eqty/feat.js';
import {
  useAnalyzeSentiment,
  useSentiment,
  useStockMetaQuery,
} from '../../lib/hooks/use-eqty-data.js';
import { usePushPayload } from '../../lib/hooks/use-push-payload.js';
import { FeatAiMd } from '../feat-ai-md/feat-ai-md.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewHeaderRight } from '../feat-view/feat-view-header.js';
import { MonoButton } from '../ui/mono-button.js';

interface Props {
  readonly code: string;
}

export function FeatAiOut({ code }: Props): React.ReactElement {
  const cached = useSentiment(code);
  const analyze = useAnalyzeSentiment(code);
  const meta = useStockMetaQuery(code);
  const push = usePushPayload();
  const sentiment = cached.data ?? null;
  const stockLabel =
    meta.data !== null && meta.data !== undefined ? `${meta.data.name} ${code}` : code;

  const onFetch = (): void => {
    analyze.mutate();
  };

  const onPush = (): void => {
    if (sentiment === null) return;
    const themeStr = sentiment.theme === null ? '' : ` · 题材[${sentiment.theme}]`;
    const head = `[${stockLabel}] sent ${sentiment.score.toFixed(2)}${themeStr}`;
    const body =
      sentiment.result.trim().length > 0 ? sentiment.result : sentiment.rawLog.join('\n');
    const composed = `${head}\n\n${body}`;
    // Slack/webhook payload is capped — leave headroom for server framing.
    const payload =
      composed.length > 15800 ? `${composed.slice(0, 15800)}\n…[truncated]` : composed;
    push.mutate({ payload });
  };

  const lines: readonly string[] =
    sentiment === null
      ? [`$ sentiment.analyze_one --code ${code}`, '// awaiting trigger']
      : sentiment.rawLog.length > 0
        ? sentiment.rawLog
        : [`$ sentiment.analyze_one --code ${code}`, `▎ score   ${sentiment.score.toFixed(2)}`];

  const tone = analyze.isPending
    ? 'amber'
    : analyze.isError
      ? 'red'
      : push.isPending
        ? 'amber'
        : push.isError
          ? 'red'
          : sentiment === null
            ? 'idle'
            : 'green';

  const markdownSource = sentiment?.result ?? '';

  return (
    <FeatView
      feat={Feat.AIOut}
      status={tone}
      statusBlink={analyze.isPending || push.isPending}
      titleSlot={
        <Text
          fontFamily="mono"
          fontSize="11px"
          letterSpacing="0.06em"
          color="term.ink2"
          whiteSpace="nowrap"
        >
          {stockLabel}
        </Text>
      }
      right={
        <FeatViewHeaderRight>
          <MonoButton
            icon="refresh"
            label="fetch sentiment"
            onClick={onFetch}
            disabled={analyze.isPending}
          />
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
        <Box
          position="relative"
          px="18px"
          py="14px"
          bg="term.panel"
          color="term.ink2"
          fontFamily="mono"
          fontSize="12px"
          lineHeight="1.7"
          flex="1"
          minH={0}
          overflow="auto"
          _after={{
            content: '""',
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'repeating-linear-gradient(to bottom, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px)',
          }}
        >
          {lines.map((line, i) => (
            <Flex key={i} gap="10px" position="relative" zIndex={1}>
              <Text
                color="term.ink3"
                minW="34px"
                textAlign="right"
                userSelect="none"
                fontSize="11px"
              >
                {String(i + 1).padStart(3, '0')}
              </Text>
              <Text color="term.ink2">{line}</Text>
            </Flex>
          ))}
          <Flex gap="10px" position="relative" zIndex={1}>
            <Text color="term.ink3" minW="34px" textAlign="right" fontSize="11px">
              {String(lines.length + 1).padStart(3, '0')}
            </Text>
            <Text>
              <Box as="span" color="term.green">
                $
              </Box>{' '}
              <Box as="span" className="blink" color="term.green">
                ▌
              </Box>
            </Text>
          </Flex>
        </Box>
        {/* A-2: collapsed by default — header-only line under the stdout
            stream. Click the restore (▢) control in its header to expand
            and read the verbatim analyst write-up. */}
        <FeatAiMd source={markdownSource} subject={stockLabel} />
      </Flex>
    </FeatView>
  );
}
