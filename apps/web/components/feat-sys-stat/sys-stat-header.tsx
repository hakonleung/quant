'use client';

/**
 * Capsule strip rendered in the SYS pane header (right slot).
 *
 * 2026-05 trim:
 *   - **Single row** — the old two-row tall header is gone. Status fits
 *     in one strip so SYS reads like every other pane.
 *   - **No WS / IDB dots.** State now reads through the WS / IDB label
 *     colour (green/amber/red). One symbol per concept beats two.
 *   - **No SCAN button.** The meta / kline capsules are themselves the
 *     scan trigger — clicking either one fires `useManualScan().run()`.
 *   - **No MEM / FPS / LCP / INP / CLS.** Web-vital + runtime metrics
 *     moved to the floating DEV pane (`<FeatDev/>`).
 */

import { Flex, Text } from '@chakra-ui/react';
import { type QueueSnapshotEntry } from '@quant/shared';

import {
  formatQueueCounter,
  queueCounterColor,
  scanLabelColor,
  triggerCapsuleTitle,
  wsStatusColor,
  idbStatusColor,
} from '../../lib/fp/sys-stat-fmt.js';
import { type ManualScan } from './use-sys-stat.js';

interface SysStatHeaderProps {
  readonly wsStatus: 'connecting' | 'open' | 'error';
  readonly meta: QueueSnapshotEntry | null;
  readonly kline: QueueSnapshotEntry | null;
  /** Unified manual scan — covers meta + kline + settlement tail.
   *  Triggered by clicking either the meta or kline capsule. */
  readonly scan: ManualScan;
  /** True while a scan is in flight (bulk RPC, enqueue, or settlement). */
  readonly scanning: boolean;
}

/**
 * Single-row WS / IDB / meta / kline strip. Status reads through label
 * colour; clicking meta or kline triggers the unified manual scan.
 */
export function SysStatHeader(props: SysStatHeaderProps): React.ReactElement {
  const labelColor = scanLabelColor(props.scanning, props.scan.flashing);
  return (
    <Flex gap="14px" align="center" fontFamily="mono" fontSize="xs" letterSpacing="0.14em">
      <Label code="WS" color={wsStatusColor(props.wsStatus)} />
      <Label code="IDB" color={idbStatusColor()} />
      <QueueCapsule
        code="meta"
        queue={props.meta}
        scanning={props.scanning}
        labelColor={labelColor}
        onClick={props.scan.run}
      />
      <QueueCapsule
        code="kline"
        queue={props.kline}
        scanning={props.scanning}
        labelColor={labelColor}
        onClick={props.scan.run}
      />
    </Flex>
  );
}

interface LabelProps {
  readonly code: string;
  readonly color: string;
}

function Label({ code, color }: LabelProps): React.ReactElement {
  return (
    <Text color={color} fontWeight="700" letterSpacing="0.18em" whiteSpace="nowrap">
      {code}
    </Text>
  );
}

interface QueueCapsuleProps {
  readonly code: string;
  readonly queue: QueueSnapshotEntry | null;
  readonly scanning: boolean;
  readonly labelColor: string;
  readonly onClick: () => void;
}

/**
 * Queue chip. The whole row is the scan trigger now — keeps the
 * affordance discoverable (the spinning ⟳ marker on hover/scan tells
 * the user the queue is doing work) without a separate `SCAN` button.
 */
function QueueCapsule({
  code,
  queue,
  scanning,
  labelColor,
  onClick,
}: QueueCapsuleProps): React.ReactElement {
  const counterColor = queueCounterColor(queue);
  return (
    <Flex
      as="button"
      onClick={onClick}
      align="center"
      gap="5px"
      whiteSpace="nowrap"
      bg="transparent"
      border="0"
      cursor="pointer"
      _hover={{ color: 'term.green' }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '2px' }}
      title={triggerCapsuleTitle(code, scanning)}
    >
      <Text color={labelColor} fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      <Text as="span" color={counterColor} fontWeight="700">
        {formatQueueCounter(queue)}
      </Text>
      {scanning && (
        <Text as="span" className="blink" color="accent" fontWeight="700">
          ⟳
        </Text>
      )}
    </Flex>
  );
}
