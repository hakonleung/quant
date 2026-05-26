'use client';

/**
 * Body-only variant of CHN.LIVE — filter chips + virtualized activity
 * feed, **without** the FeatView wrapper. Lifted out of
 * `feat-channel.tsx` so the merged SYS.MAIN pane can reuse the feed
 * inside its own FeatView shell (capsule strip in the header).
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChannelId, ChannelMessageSource } from '@quant/shared';
import { useMemo, useRef, useState } from 'react';

import { useChannelActivity } from '../../lib/socket/use-channel-activity.js';
import { ActivityRow } from './activity-row.js';
import { FilterChips, type FilterState } from './filter-chips.js';

const ROW_ESTIMATE_PX = 56;

export function ChannelLiveBody(): React.ReactElement {
  const { rows, status, error } = useChannelActivity();
  const [filter, setFilter] = useState<FilterState>({
    sources: new Set<ChannelMessageSource>(['system', 'manual', 'inbound']),
    channels: new Set<ChannelId>(['slack', 'feishu']),
  });

  const filtered = useMemo(
    () => rows.filter((row) => filter.sources.has(row.source) && filter.channels.has(row.channel)),
    [rows, filter],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
  });

  return (
    <Flex direction="column" flex="1" minH={0} color="term.ink2" fontFamily="mono" fontSize="sm">
      <FilterChips state={filter} onChange={setFilter} />
      {error !== null && status === 'error' ? (
        <Box px="14px" py="6px" color="up" fontSize="xs">
          stream error: {error}
        </Box>
      ) : null}
      <Box
        ref={parentRef}
        flex="1"
        minH={0}
        overflowY="auto"
        px="6px"
        py="4px"
        borderTopWidth="1px"
        borderColor="term.line"
      >
        {filtered.length === 0 ? (
          <Text color="term.ink3" px="8px" py="6px">
            {status === 'connecting' ? 'connecting…' : 'no activity yet'}
          </Text>
        ) : (
          <Box style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = filtered[vi.index];
              if (row === undefined) return null;
              return (
                <Box
                  key={row.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${String(vi.start)}px)`,
                  }}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                >
                  <ActivityRow row={row} />
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    </Flex>
  );
}
