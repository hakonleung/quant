'use client';

/**
 * Filter chips above the activity feed.
 *
 * Two independent dimensions:
 *   1. source: system / manual / inbound — what kind of event
 *   2. channel: slack / feishu — which IM
 *
 * The chip toggles a single dimension at a time; clicking already-on
 * chip leaves at least one chip on per dimension (otherwise the feed
 * empties for a confusing reason).
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { ChannelId, ChannelMessageSource } from '@quant/shared';

export interface FilterState {
  readonly sources: ReadonlySet<ChannelMessageSource>;
  readonly channels: ReadonlySet<ChannelId>;
}

interface FilterChipsProps {
  readonly state: FilterState;
  readonly onChange: (next: FilterState) => void;
}

const SOURCE_OPTIONS: readonly { id: ChannelMessageSource; label: string }[] = [
  { id: 'system', label: 'system' },
  { id: 'manual', label: 'manual' },
  { id: 'inbound', label: 'inbound' },
];

const CHANNEL_OPTIONS: readonly { id: ChannelId; label: string }[] = [
  { id: 'slack', label: 'slack' },
  { id: 'feishu', label: 'feishu' },
];

export function FilterChips({ state, onChange }: FilterChipsProps): React.ReactElement {
  const toggleSource = (id: ChannelMessageSource): void => {
    const next = new Set(state.sources);
    if (next.has(id)) {
      if (next.size === 1) return;
      next.delete(id);
    } else next.add(id);
    onChange({ ...state, sources: next });
  };
  const toggleChannel = (id: ChannelId): void => {
    const next = new Set(state.channels);
    if (next.has(id)) {
      if (next.size === 1) return;
      next.delete(id);
    } else next.add(id);
    onChange({ ...state, channels: next });
  };

  return (
    <Flex
      align="center"
      gap="10px"
      px="14px"
      py="6px"
      fontFamily="mono"
      fontSize="xs"
      color="term.ink3"
      flexWrap="wrap"
    >
      <Text color="term.ink3" letterSpacing="0.06em" minW="28px">
        SRC
      </Text>
      {SOURCE_OPTIONS.map((opt) => (
        <Chip
          key={opt.id}
          active={state.sources.has(opt.id)}
          label={opt.label}
          onClick={(): void => {
            toggleSource(opt.id);
          }}
        />
      ))}
      <Text color="term.ink3" letterSpacing="0.06em" minW="28px" ml="6px">
        CH
      </Text>
      {CHANNEL_OPTIONS.map((opt) => (
        <Chip
          key={opt.id}
          active={state.channels.has(opt.id)}
          label={opt.label}
          onClick={(): void => {
            toggleChannel(opt.id);
          }}
        />
      ))}
    </Flex>
  );
}

interface ChipProps {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}

function Chip({ active, label, onClick }: ChipProps): React.ReactElement {
  return (
    <Box
      as="button"
      onClick={onClick}
      px="6px"
      py="1px"
      borderWidth="1px"
      borderColor={active ? 'term.green' : 'term.line'}
      color={active ? 'term.green' : 'term.ink3'}
      bg={active ? 'term.panel' : 'transparent'}
      letterSpacing="0.04em"
      fontFamily="mono"
      fontSize="xs"
      cursor="pointer"
      _hover={{ borderColor: active ? 'term.green' : 'term.ink3' }}
    >
      {label}
    </Box>
  );
}
