'use client';

/**
 * SYS.MAIN — unified status pane.
 *
 * Merges the historical SYS.STAT (capsule strip in the header) with the
 * CHN.LIVE feed (channel + IM activity rows in the body). The watch
 * broadcaster already emits `kind: 'watch.hit'` activity through the
 * channel bus, so the unified feed naturally surfaces watch outputs
 * alongside system-initiated and manual pushes — no parallel watch
 * stream is required.
 *
 * 2026-05 cleanup: the tall (two-row) header is gone. SYS now uses the
 * standard short FeatView header — same shape as EQ / EQ.LIST / PAT —
 * so all panes read as siblings. Web vitals + runtime metrics moved
 * out to the floating DEV pane (`<FeatDev/>`).
 *
 * Layout:
 *   - FeatView header (right slot)  → SysStatHeader (capsule strip)
 *   - FeatView body                 → ChannelLive (filter chips + feed)
 */

import { Box, Flex } from '@chakra-ui/react';
import type { QueueSnapshotEntry } from '@quant/shared';

import { Feat } from '../../lib/eqty/feat.js';
import { findQueue } from '../../lib/fp/sys-stat-fmt.js';
import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';
import { ChannelLiveBody } from '../feat-channel/feat-channel-body.js';
import { FeatView } from '../feat-view/feat-view.js';
import { SysStatHeader } from '../feat-sys-stat/sys-stat-header.js';
import { useBlacklistInvalidate, useManualScan } from '../feat-sys-stat/use-sys-stat.js';

interface FeatSysMainProps {
  /** `mobile` → render without FeatView chrome (the mobile shell owns
   *  the full screen). Default → desktop topbar pane. */
  readonly embedded?: 'mobile';
}

export function FeatSysMain({ embedded }: FeatSysMainProps = {}): React.ReactElement {
  const stream = useQueueStream();
  const scan = useManualScan();

  const scanning = stream.snapshot?.scanning ?? false;
  useBlacklistInvalidate(scanning);

  const queues: readonly QueueSnapshotEntry[] = stream.snapshot?.queues ?? [];

  const headerProps = {
    wsStatus: stream.status,
    meta: findQueue(queues, 'meta'),
    kline: findQueue(queues, 'kline'),
    scan,
    scanning,
  } as const;

  const body = (
    <Flex direction="column" flex="1" minH={0}>
      <ChannelLiveBody />
    </Flex>
  );

  if (embedded === 'mobile') {
    // The mobile shell owns the screen — drop the FeatView chrome
    // (whose `defaultMinimized` + `bodyOverlay` config makes no sense
    // when the pane *is* the tab) and render the capsule strip as a
    // top bar with the activity feed below.
    return (
      <Flex direction="column" h="100%" minH={0} bg="term.panel" color="term.ink2">
        <Box
          px="10px"
          py="6px"
          borderBottomWidth="1px"
          borderColor="term.line"
          flexShrink={0}
          overflowX="auto"
        >
          <SysStatHeader {...headerProps} />
        </Box>
        {body}
      </Flex>
    );
  }

  return (
    <FeatView feat={Feat.SysMain} right={<SysStatHeader {...headerProps} />}>
      {body}
    </FeatView>
  );
}
