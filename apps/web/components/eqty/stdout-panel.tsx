'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import type { Sentiment } from '@quant/shared';

import { Pane } from '../shell/pane.js';

interface Props {
  readonly code: string;
  /** Latest sentiment payload — supplied by the page after the user
   *  clicks FETCH on the SentimentPanel. */
  readonly sentiment: Sentiment | null;
}

export function StdoutPanel({ code, sentiment }: Props): React.ReactElement {
  const lines: readonly string[] = sentiment === null
    ? [`$ sentiment.analyze_one --code ${code}`, '// awaiting trigger']
    : sentiment.rawLog.length > 0
      ? sentiment.rawLog
      : [`$ sentiment.analyze_one --code ${code}`, `▎ score   ${sentiment.score.toFixed(2)}`];

  return (
    <Pane
      id="210"
      title="stdout · sentiment.analyze_one"
      gridArea="R2"
      right={<Text color="prompt">{sentiment === null ? '○ idle' : '● cached'}</Text>}
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
    </Pane>
  );
}
