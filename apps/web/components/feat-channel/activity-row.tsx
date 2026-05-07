'use client';

/**
 * One row of the channel activity feed. Layout:
 *
 *   [time] [src] [channel] [kind]   <text…>          [status?]
 *
 * Times render in BJT (Asia/Shanghai); the underlying `ts` is always
 * UTC ISO 8601 (CLAUDE.md §2.8). Status pellet only appears for
 * outbound rows; inbound rows show the sender id instead.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { ChannelActivity, ChannelDeliveryStatus } from '@quant/shared';

interface ActivityRowProps {
  readonly row: ChannelActivity;
}

const STATUS_COLOR: Readonly<Record<ChannelDeliveryStatus, string>> = {
  pending: 'term.ink3',
  sent: 'term.green',
  failed: 'term.red',
  dryrun: 'term.amber',
};

const SRC_LABEL: Readonly<Record<ChannelActivity['source'], string>> = {
  system: 'sys',
  manual: 'man',
  inbound: 'in',
};

const SRC_COLOR: Readonly<Record<ChannelActivity['source'], string>> = {
  system: 'term.amber',
  manual: 'term.ink',
  inbound: 'term.cyan',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', {
      hour12: false,
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

export function ActivityRow({ row }: ActivityRowProps): React.ReactElement {
  return (
    <Flex
      align="flex-start"
      gap="8px"
      px="8px"
      py="6px"
      borderBottomWidth="1px"
      borderColor="term.line2"
      _hover={{ bg: 'term.panel2' }}
    >
      <Text fontSize="10px" color="term.ink3" flexShrink={0} minW="58px" lineHeight="1.5">
        {formatTime(row.ts)}
      </Text>
      <Text
        fontSize="10px"
        color={SRC_COLOR[row.source]}
        flexShrink={0}
        minW="28px"
        letterSpacing="0.06em"
        lineHeight="1.5"
      >
        {SRC_LABEL[row.source]}
      </Text>
      <Text
        fontSize="10px"
        color="term.ink3"
        flexShrink={0}
        minW="44px"
        letterSpacing="0.04em"
        lineHeight="1.5"
      >
        {row.channel}
      </Text>
      <Text
        fontSize="10px"
        color="term.ink"
        flexShrink={0}
        minW="80px"
        letterSpacing="0.02em"
        lineHeight="1.5"
      >
        {row.kind}
      </Text>
      <Box flex="1" minW={0} lineHeight="1.5">
        {row.title !== undefined ? (
          <Text fontSize="11px" color="term.ink" fontWeight="600" mb="1px">
            {row.title}
          </Text>
        ) : null}
        <Text fontSize="11px" color="term.ink2" whiteSpace="pre-wrap" wordBreak="break-word">
          {row.text}
        </Text>
        {row.error !== undefined ? (
          <Text fontSize="10px" color="term.red" mt="2px">
            err: {row.error}
          </Text>
        ) : null}
      </Box>
      <Box flexShrink={0} textAlign="right" minW="64px">
        {row.status !== undefined ? (
          <Text fontSize="10px" color={STATUS_COLOR[row.status]} letterSpacing="0.04em">
            {row.status}
          </Text>
        ) : row.sender !== undefined ? (
          <Text fontSize="10px" color="term.ink3">
            {row.sender}
          </Text>
        ) : null}
      </Box>
    </Flex>
  );
}
