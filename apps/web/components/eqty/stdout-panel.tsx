'use client';

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import type { Sentiment } from '@quant/shared';
import { useEffect } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useAnalyzeSentiment, useSentiment } from '../../lib/hooks/use-eqty-data.js';
import { MarkdownPreviewer } from '../modules/markdown-previewer.js';
import { Pane } from '../shell/pane.js';

interface Props {
  readonly code: string;
  /** Bubbles the latest analysis result up to the page so siblings (e.g.
   *  the Slack panel) can render the same payload. */
  readonly onResult?: (s: Sentiment) => void;
}

export function StdoutPanel({ code, onResult }: Props): React.ReactElement {
  const cached = useSentiment(code);
  const analyze = useAnalyzeSentiment(code);
  const sentiment = cached.data ?? null;

  useEffect(() => {
    if (sentiment !== null && onResult !== undefined) {
      onResult(sentiment);
    }
  }, [sentiment, onResult]);

  const onFetch = (): void => {
    analyze.mutate(undefined, {
      onSuccess: (data) => {
        onResult?.(data);
      },
    });
  };

  const lines: readonly string[] =
    sentiment === null
      ? [`$ sentiment.analyze_one --code ${code}`, '// awaiting trigger']
      : sentiment.rawLog.length > 0
        ? sentiment.rawLog
        : [`$ sentiment.analyze_one --code ${code}`, `▎ score   ${sentiment.score.toFixed(2)}`];

  const status = analyze.isPending ? (
    <Text color="accent">● analyzing</Text>
  ) : analyze.isError ? (
    <Text color="up">✘ {analyze.error.message}</Text>
  ) : sentiment === null ? (
    <Text color="prompt">○ idle</Text>
  ) : (
    <Text color="prompt">● cached</Text>
  );

  const markdownSource = sentiment?.result ?? '';

  return (
    <Pane
      feat={Feat.Insight}
      right={
        <Flex gap="8px" align="center">
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
            _hover={{ bg: 'accentDark' }}
          >
            ⟳ FETCH
          </Button>
        </Flex>
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
              <Text color="term.ink3" minW="34px" textAlign="right" userSelect="none" fontSize="11px">
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
        <MarkdownPreviewer source={markdownSource} />
      </Flex>
    </Pane>
  );
}
