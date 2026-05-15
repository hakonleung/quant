'use client';

/**
 * Capsule strip rendered in the SYS pane header (right slot).
 *
 * Extracted from `feat-sys-stat.tsx` so it can be reused by the merged
 * SYS.MAIN pane (status capsules + CHN.LIVE feed) without dragging the
 * whole orchestrator + body along.
 */

import { Flex, Text } from '@chakra-ui/react';
import { type QueueSnapshotEntry } from '@quant/shared';

import {
  formatMemMb,
  formatQueueCounter,
  fpsColor,
  memColor,
  queueCounterColor,
  scanLabelColor,
  triggerCapsuleTitle,
  wsAppearance,
} from '../../lib/fp/sys-stat-fmt.js';
import {
  fmtCls,
  fmtMs,
  vitalColor,
  vitalTitle,
  type VitalCode,
} from '../../lib/fp/web-vitals-fmt.js';
import { type VitalSample, type WebVitals } from '../../lib/hooks/use-web-vitals.js';
import { type ManualScan } from './use-sys-stat.js';

interface SysStatHeaderProps {
  readonly wsStatus: 'connecting' | 'open' | 'error';
  readonly meta: QueueSnapshotEntry | null;
  readonly kline: QueueSnapshotEntry | null;
  /** Unified manual scan — covers meta + kline + settlement tail. */
  readonly scan: ManualScan;
  /** True while a scan is in flight (bulk RPC, enqueue, or settlement). */
  readonly scanning: boolean;
  readonly fps: number;
  readonly memMb: number | null;
  readonly vitals: WebVitals;
}

/** Single-row variant — kept for the desktop topbar's old single-line
 *  layout if anything still mounts it directly. The tall SYS header
 *  prefers {@link SysStatHeaderPrimary} + {@link SysStatHeaderVitals}. */
export function SysStatHeader(props: SysStatHeaderProps): React.ReactElement {
  return (
    <Flex gap="14px" align="center" fontFamily="mono" fontSize="10px" letterSpacing="0.14em">
      <SysStatHeaderPrimary {...props} />
      <SysStatHeaderVitals vitals={props.vitals} />
    </Flex>
  );
}

/** Operational state — WS / IDB / meta / kline / BL / MEM / FPS. Goes
 *  on the first row of the tall header. */
export function SysStatHeaderPrimary(props: SysStatHeaderProps): React.ReactElement {
  const ws = wsAppearance(props.wsStatus);
  return (
    <Flex gap="14px" align="center" fontFamily="mono" fontSize="10px" letterSpacing="0.14em">
      <Capsule code="WS">
        <Text as="span" color={ws.color}>
          {ws.glyph}
        </Text>
      </Capsule>
      <Capsule code="IDB">
        <Text as="span" color="term.green">
          ●
        </Text>
      </Capsule>
      <QueueCapsule code="meta" queue={props.meta} scanning={props.scanning} />
      <QueueCapsule code="kline" queue={props.kline} scanning={props.scanning} />
      <TriggerCapsule code="SCAN" scan={props.scan} scanning={props.scanning} />
      <Capsule code="MEM">
        <Text as="span" color={memColor(props.memMb)} fontWeight="700">
          {formatMemMb(props.memMb)}
        </Text>
      </Capsule>
      <Capsule code="FPS">
        <Text as="span" color={fpsColor(props.fps)} fontWeight="700">
          {String(props.fps)}
        </Text>
      </Capsule>
    </Flex>
  );
}

/** Web Vitals row — LCP / INP / CLS. Goes on the second row of the
 *  tall header where the user can keep an eye on them without crowding
 *  the operational capsules. */
export function SysStatHeaderVitals({
  vitals,
}: {
  readonly vitals: WebVitals;
}): React.ReactElement {
  return (
    <Flex gap="14px" align="center" fontFamily="mono" fontSize="10px" letterSpacing="0.14em">
      <VitalCapsule code="LCP" sample={vitals.lcp} format={fmtMs} />
      <VitalCapsule code="INP" sample={vitals.inp} format={fmtMs} />
      <VitalCapsule code="CLS" sample={vitals.cls} format={fmtCls} />
    </Flex>
  );
}

interface CapsuleProps {
  readonly code: string;
  readonly children: React.ReactNode;
}

function Capsule({ code, children }: CapsuleProps): React.ReactElement {
  return (
    <Flex align="center" gap="5px" whiteSpace="nowrap">
      <Text color="term.green" fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      {children}
    </Flex>
  );
}

interface QueueCapsuleProps {
  readonly code: string;
  readonly queue: QueueSnapshotEntry | null;
  readonly scanning: boolean;
}

function QueueCapsule({ code, queue, scanning }: QueueCapsuleProps): React.ReactElement {
  const counterColor = queueCounterColor(queue);
  const labelColor = scanLabelColor(scanning, false);
  return (
    <Flex align="center" gap="5px" whiteSpace="nowrap" title={`${code} queue`}>
      <Text color={labelColor} fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      <Text as="span" color={counterColor} fontWeight="700">
        {formatQueueCounter(queue)}
      </Text>
      {scanning && (
        <Text as="span" className="blink" color="term.amber" fontWeight="700">
          ⟳
        </Text>
      )}
    </Flex>
  );
}

interface TriggerCapsuleProps {
  readonly code: string;
  readonly scan: ManualScan;
  readonly scanning: boolean;
}

function TriggerCapsule({ code, scan, scanning }: TriggerCapsuleProps): React.ReactElement {
  const labelColor = scanLabelColor(scanning, scan.flashing);
  return (
    <Flex
      as="button"
      onClick={(): void => {
        scan.run();
      }}
      align="center"
      gap="5px"
      whiteSpace="nowrap"
      bg="transparent"
      cursor="pointer"
      _hover={{ color: 'term.green' }}
      title={triggerCapsuleTitle(code, scanning)}
    >
      <Text color={labelColor} fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      {scanning && (
        <Text as="span" className="blink" color="term.amber" fontWeight="700">
          ⟳
        </Text>
      )}
    </Flex>
  );
}

interface VitalCapsuleProps {
  readonly code: VitalCode;
  readonly sample: VitalSample | null;
  readonly format: (s: VitalSample | null) => string;
}

function VitalCapsule({ code, sample, format }: VitalCapsuleProps): React.ReactElement {
  return (
    <Capsule code={code}>
      <Text as="span" color={vitalColor(sample)} fontWeight="700" title={vitalTitle(code, sample)}>
        {format(sample)}
      </Text>
    </Capsule>
  );
}
