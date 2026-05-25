'use client';

/**
 * Result panel for the search box's batch-paste mode.
 *
 * Renders one of three states from `matchBatch`:
 *   - all entries resolved → green `✓ N matched` chip + Apply button
 *   - some unresolved      → red `✘ N unmatched` chip + the offending strings
 *   - input invalid        → muted hint with the parser's reason
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';

import type { BatchMatchResult } from '../../lib/fp/batch-stock-match.js';

interface Props {
  readonly result: BatchMatchResult;
  readonly loading: boolean;
  readonly onApply: () => void;
}

export function BatchPanel({ result, loading, onApply }: Props): React.ReactElement {
  const matchedCount = result.kind === 'matched' ? result.items.length : 0;
  const canApply = !loading && result.kind === 'matched' && matchedCount > 0;
  return (
    <Box
      mt="4px"
      borderWidth="1px"
      borderColor="line"
      bg="panel"
      p="10px"
      fontFamily="mono"
      fontSize="11px"
      color="ink2"
    >
      <BatchHeader result={result} canApply={canApply} onApply={onApply} />
      <BatchBody result={result} />
    </Box>
  );
}

interface HeaderProps {
  readonly result: BatchMatchResult;
  readonly canApply: boolean;
  readonly onApply: () => void;
}

function BatchHeader({ result, canApply, onApply }: HeaderProps): React.ReactElement {
  return (
    <Flex align="center" gap="10px" mb="6px">
      <Text color="down" letterSpacing="0.16em" fontSize="10px" fontWeight="700">
        ▎ BATCH
      </Text>
      <BatchStatus result={result} />
      <Box flex="1" />
      <Button
        size="xs"
        h="22px"
        px="10px"
        borderRadius="0"
        bg={canApply ? 'accent' : 'panel'}
        color={canApply ? 'panel' : 'ink3'}
        borderWidth="1px"
        borderColor={canApply ? 'accent' : 'line'}
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.16em"
        fontWeight="700"
        disabled={!canApply}
        onMouseDown={(e): void => {
          e.preventDefault();
        }}
        onClick={onApply}
      >
        APPLY
      </Button>
    </Flex>
  );
}

function BatchStatus({ result }: { result: BatchMatchResult }): React.ReactElement {
  if (result.kind === 'matched') {
    return <Text color="up">✓ {result.items.length} matched</Text>;
  }
  if (result.kind === 'partial') {
    return (
      <Text color="down">
        ✘ {result.unmatched.length} unmatched · {result.matched.length} ok
      </Text>
    );
  }
  return <Text color="ink3">// {result.reason}</Text>;
}

function BatchBody({ result }: { result: BatchMatchResult }): React.ReactElement | null {
  if (result.kind === 'partial' && result.unmatched.length > 0) {
    return (
      <Box maxH="120px" overflow="auto">
        <Text color="ink3" mb="2px" fontSize="10px">
          // unmatched entries:
        </Text>
        <Flex wrap="wrap" gap="6px">
          {result.unmatched.map((u) => (
            <Text
              key={u}
              px="6px"
              py="1px"
              borderWidth="1px"
              borderColor="down"
              color="down"
              fontSize="10px"
            >
              {u}
            </Text>
          ))}
        </Flex>
      </Box>
    );
  }
  if (result.kind === 'matched') {
    return (
      <Box maxH="120px" overflow="auto">
        <Flex wrap="wrap" gap="6px">
          {result.items.slice(0, 50).map((it) => (
            <Text
              key={`${it.market}:${it.code}`}
              px="6px"
              py="1px"
              borderWidth="1px"
              borderColor="line"
              color="ink2"
              fontSize="10px"
            >
              <Text as="span" color="ink3" mr="4px">
                [{it.market}]
              </Text>
              {it.code} · {it.name}
            </Text>
          ))}
          {result.items.length > 50 && (
            <Text color="ink3" fontSize="10px">
              +{result.items.length - 50} more
            </Text>
          )}
        </Flex>
      </Box>
    );
  }
  return null;
}
