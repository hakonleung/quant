'use client';

/**
 * Status pane (SYS.STAT, cyber skin).
 *
 * Identical to the historical footer pane (terminal corners, minimize /
 * fullscreen toggles, blinking caret in body) — only the right-slot
 * capsule strip is extended with `MEM` (Chromium-only JS-heap usage)
 * and `FPS` (rAF-based frame rate). The pane is now mounted next to
 * the brand mark in {@link TopBar}, not at the bottom of the page.
 *
 * Capsules at a glance:
 *
 *   1. WS    — Socket.IO connection: live | connecting | lost
 *   2. IDB   — local-storage backend identifier
 *   3. meta  — `inFlight/pending` (always visible; 0/0 when idle)
 *   4. kline — `inFlight/pending`
 *   5. BL    — manual blacklist scan trigger
 *   6. LCP   — Largest Contentful Paint (Google Core Web Vital)
 *   7. INP   — Interaction to Next Paint (Google Core Web Vital)
 *   8. CLS   — Cumulative Layout Shift (Google Core Web Vital)
 *   9. MEM   — used JS-heap MB (—  on non-Chromium browsers)
 *  10. FPS   — animation-frame rate (1Hz update window)
 *
 * Body carries the wall clock and the most recent scan trigger info.
 *
 * Manual scan triggers are **fire-and-forget**: clicking META / KLINE
 * posts to `/api/orchestration/scan`, the gateway returns 202 Accepted
 * within a few ms, and progress shows up via the queue.snapshot socket
 * topic's pending counters. The button itself flashes briefly on
 * submit; long-running work surfaces in the queue capsule, not the
 * button.
 *
 * Internal layout (this file):
 *
 *   FeatSysStat            — orchestrator: hooks + dispatching to the
 *                            two presentational subviews.
 *   FeatSysStatHeader      — capsule strip (right slot of FeatView).
 *   FeatSysStatBody        — clock + scan readouts (body of FeatView).
 *   Capsule / QueueCapsule / TriggerCapsule / ScanReadout
 *                          — leaf presentational pieces. Pure props in,
 *                            JSX out; all colour / label policy lives
 *                            in `lib/fp/sys-stat-fmt.ts`.
 *   useManualScan / useClock / useFps / useMemoryMb /
 *   useBlacklistInvalidate — local hooks; the only places this file
 *                            owns side effects.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { type QueueSnapshotEntry } from '@quant/shared';

import { Feat } from '../../lib/eqty/feat.js';
import {
  findQueue,
  formatMemMb,
  formatQueueCounter,
  fpsColor,
  isScanCovering,
  memColor,
  queueCapsuleTitle,
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
import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';
import { useWebVitals, type VitalSample, type WebVitals } from '../../lib/hooks/use-web-vitals.js';
import { FeatView } from '../feat-view/feat-view.js';
import {
  useBlacklistInvalidate,
  useClock,
  useFps,
  useManualScan,
  useMemoryMb,
  type ManualScan,
} from './use-sys-stat.js';

// ─────────────────────── orchestrator ─────────────────────

export function FeatSysStat(): React.ReactElement {
  const stream = useQueueStream();
  const now = useClock();
  const metaScan = useManualScan('meta');
  const klineScan = useManualScan('kline');
  const blacklistScan = useManualScan('blacklist');
  const fps = useFps();
  const memMb = useMemoryMb();
  const vitals = useWebVitals();

  const activeScans = stream.snapshot?.activeScans;
  const isBlacklistScanning = isScanCovering(activeScans, 'blacklist');
  useBlacklistInvalidate(isBlacklistScanning);

  const queues: readonly QueueSnapshotEntry[] = stream.snapshot?.queues ?? [];

  return (
    <FeatView
      feat={Feat.SysStat}
      right={
        <FeatSysStatHeader
          wsStatus={stream.status}
          meta={findQueue(queues, 'meta')}
          kline={findQueue(queues, 'kline')}
          metaScan={metaScan}
          klineScan={klineScan}
          blacklistScan={blacklistScan}
          metaScanning={isScanCovering(activeScans, 'meta')}
          klineScanning={isScanCovering(activeScans, 'kline')}
          blacklistScanning={isBlacklistScanning}
          fps={fps}
          memMb={memMb}
          vitals={vitals}
        />
      }
    >
      <FeatSysStatBody
        now={now}
        metaScan={metaScan}
        klineScan={klineScan}
        blacklistScan={blacklistScan}
      />
    </FeatView>
  );
}

// ─────────────────────── header (capsule strip) ─────────────────────

interface HeaderProps {
  readonly wsStatus: 'connecting' | 'open' | 'error';
  readonly meta: QueueSnapshotEntry | null;
  readonly kline: QueueSnapshotEntry | null;
  readonly metaScan: ManualScan;
  readonly klineScan: ManualScan;
  readonly blacklistScan: ManualScan;
  readonly metaScanning: boolean;
  readonly klineScanning: boolean;
  readonly blacklistScanning: boolean;
  readonly fps: number;
  readonly memMb: number | null;
  readonly vitals: WebVitals;
}

function FeatSysStatHeader(props: HeaderProps): React.ReactElement {
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
      <QueueCapsule
        code="meta"
        queue={props.meta}
        scan={props.metaScan}
        scanning={props.metaScanning}
      />
      <QueueCapsule
        code="kline"
        queue={props.kline}
        scan={props.klineScan}
        scanning={props.klineScanning}
      />
      <TriggerCapsule code="BL" scan={props.blacklistScan} scanning={props.blacklistScanning} />
      <VitalCapsule code="LCP" sample={props.vitals.lcp} format={fmtMs} />
      <VitalCapsule code="INP" sample={props.vitals.inp} format={fmtMs} />
      <VitalCapsule code="CLS" sample={props.vitals.cls} format={fmtCls} />
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

// ─────────────────────── body (clock + readouts) ─────────────────────

interface BodyProps {
  readonly now: string;
  readonly metaScan: ManualScan;
  readonly klineScan: ManualScan;
  readonly blacklistScan: ManualScan;
}

function FeatSysStatBody({
  now,
  metaScan,
  klineScan,
  blacklistScan,
}: BodyProps): React.ReactElement {
  return (
    <Box
      px="12px"
      py="6px"
      bg="term.panel"
      color="term.ink2"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.14em"
      h="100%"
    >
      <Flex gap="14px" align="center" wrap="wrap">
        <Text color="term.ink3">$ status --watch</Text>
        <Text color="term.ink2">{now}</Text>
        <ScanReadout label="meta" scan={metaScan} />
        <ScanReadout label="kline" scan={klineScan} />
        <ScanReadout label="bl" scan={blacklistScan} />
        <Text as="span" className="blink" color="term.green">
          ▌
        </Text>
      </Flex>
    </Box>
  );
}

// ─────────────────────── capsule primitives ─────────────────────

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
  readonly scan: ManualScan;
  readonly scanning: boolean;
}

function QueueCapsule({ code, queue, scan, scanning }: QueueCapsuleProps): React.ReactElement {
  const counterColor = queueCounterColor(queue);
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
      title={queueCapsuleTitle(code, scanning)}
    >
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

/**
 * Click-to-fire capsule for kinds that have **no queue** (single-shot
 * RPCs like `blacklist`). Same flash + scanning indicator as
 * {@link QueueCapsule}, minus the `inFlight/pending` counter.
 */
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

interface ScanReadoutProps {
  readonly label: string;
  readonly scan: ManualScan;
}

function ScanReadout({ label, scan }: ScanReadoutProps): React.ReactElement | null {
  if (scan.error !== null) {
    return (
      <Text color="term.red">
        // {label}: {scan.error}
      </Text>
    );
  }
  if (scan.last === null) return null;
  return (
    <Text color="term.ink3">
      // {label}: triggered {scan.last.startedAt.slice(11, 19)}
      {scan.last.started ? '' : ' (coalesced)'}
    </Text>
  );
}
