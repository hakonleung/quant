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
 * Layout:
 *   - FeatView header (right slot)  → SysStatHeader (capsule strip)
 *   - FeatView body                 → ChannelLive (filter chips + feed)
 */

import { Box, Flex } from '@chakra-ui/react';
import type { QueueSnapshotEntry } from '@quant/shared';

import { Feat } from '../../lib/eqty/feat.js';
import { findQueue } from '../../lib/fp/sys-stat-fmt.js';
import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';
import { useWebVitals } from '../../lib/hooks/use-web-vitals.js';
import { ChannelLiveBody } from '../feat-channel/feat-channel-body.js';
import { FeatView } from '../feat-view/feat-view.js';
import {
  SysStatHeader,
  SysStatHeaderPrimary,
  SysStatHeaderVitals,
} from '../feat-sys-stat/sys-stat-header.js';
import {
  useBlacklistInvalidate,
  useFps,
  useManualScan,
  useMemoryMb,
} from '../feat-sys-stat/use-sys-stat.js';

interface FeatSysMainProps {
  /** `mobile` → render without FeatView chrome (the mobile shell owns
   *  the full screen). Default → desktop topbar pane. */
  readonly embedded?: 'mobile';
}

export function FeatSysMain({ embedded }: FeatSysMainProps = {}): React.ReactElement {
  const stream = useQueueStream();
  const scan = useManualScan();
  const fps = useFps();
  const memMb = useMemoryMb();
  const vitals = useWebVitals();

  const scanning = stream.snapshot?.scanning ?? false;
  useBlacklistInvalidate(scanning);

  const queues: readonly QueueSnapshotEntry[] = stream.snapshot?.queues ?? [];

  const headerProps = {
    wsStatus: stream.status,
    meta: findQueue(queues, 'meta'),
    kline: findQueue(queues, 'kline'),
    scan,
    scanning,
    fps,
    memMb,
    vitals,
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
    // top bar with the activity feed below. We keep the single-row
    // strip here because the mobile pane has plenty of vertical space
    // for the body and a horizontal scroll on the strip is fine.
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
    <FeatView
      feat={Feat.SysMain}
      tallHeader
      right={<SysStatHeaderPrimary {...headerProps} />}
      rightSecondary={<SysStatHeaderVitals vitals={vitals} />}
    >
      {body}
    </FeatView>
  );
}
