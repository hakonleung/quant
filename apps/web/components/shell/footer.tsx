'use client';

/**
 * Status pane (Feat 300, cyber skin).
 *
 * The site footer slot — wrapped in a regular {@link Pane} so it
 * inherits the workbench chrome (terminal corners, minimize/fullscreen
 * toggles). Header shows four "·" capsules at a glance:
 *
 *   1. SSE   — live | connecting | lost
 *   2. IDB   — local-storage backend identifier
 *   3. meta  — `inFlight/pending` (always visible; 0/0 when idle)
 *   4. kline — `inFlight/pending`
 *
 * Body carries the wall clock and the most recent scan trigger info.
 *
 * Manual scan triggers are **fire-and-forget**: clicking META / KLINE
 * posts to `/api/orchestration/scan`, the gateway returns 202 Accepted
 * within a few ms, and progress shows up via the SSE stream's pending
 * counters. The button itself flashes briefly on submit; long-running
 * work surfaces in the queue capsule, not the button.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import {
  ScanAcceptedSchema,
  type QueueSnapshotEntry,
  type ScanAccepted,
  type ScanKind,
} from '@quant/shared';
import { useEffect, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';
import { Pane } from './pane.js';

export function Footer(): React.ReactElement {
  const stream = useQueueStream();
  const now = useClock();
  const metaScan = useManualScan('meta');
  const klineScan = useManualScan('kline');

  const sseColor =
    stream.status === 'open' ? 'term.green' : stream.status === 'error' ? 'term.red' : 'term.amber';
  const sseGlyph = stream.status === 'open' ? '●' : stream.status === 'error' ? '✘' : '○';

  const queues: readonly QueueSnapshotEntry[] = stream.snapshot?.queues ?? [];
  const meta = queues.find((q) => q.name === 'meta') ?? null;
  const kline = queues.find((q) => q.name === 'kline') ?? null;

  return (
    <Pane
      feat={Feat.Status}
      right={
        <Flex gap="14px" align="center" fontFamily="mono" fontSize="10px" letterSpacing="0.14em">
          <Capsule code="SSE">
            <Text as="span" color={sseColor}>
              {sseGlyph}
            </Text>
          </Capsule>
          <Capsule code="IDB">
            <Text as="span" color="term.green">
              ●
            </Text>
          </Capsule>
          <QueueCapsule code="meta" queue={meta} scan={metaScan} />
          <QueueCapsule code="kline" queue={kline} scan={klineScan} />
        </Flex>
      }
    >
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
          <Text as="span" className="blink" color="term.green">
            ▌
          </Text>
        </Flex>
      </Box>
    </Pane>
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

function QueueCapsule({
  code,
  queue,
  scan,
}: {
  code: string;
  queue: QueueSnapshotEntry | null;
  scan: ManualScan;
}): React.ReactElement {
  const counterColor = queue === null ? 'term.ink3' : queue.paused ? 'term.amber' : 'term.red';
  // The label flashes amber for one second after a successful submit
  // so the user gets immediate feedback even though the network
  // round-trip is < 10ms; sustained activity shows up in the counter.
  const labelColor = scan.flashing ? 'term.amber' : 'term.green';
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
      title={`trigger ${code} scan now`}
    >
      <Text color={labelColor} fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      <Text as="span" color={counterColor} fontWeight="700">
        {String(queue?.inFlight ?? 0)}/{String(queue?.pending ?? 0)}
      </Text>
    </Flex>
  );
}

function ScanReadout({
  label,
  scan,
}: {
  label: string;
  scan: ManualScan;
}): React.ReactElement | null {
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

interface ManualScan {
  readonly run: () => void;
  /** True for ~1s after a successful submit; gives the button a flash. */
  readonly flashing: boolean;
  readonly last: ScanAccepted | null;
  readonly error: string | null;
}

const FLASH_MS = 1000;

function useManualScan(kind: ScanKind): ManualScan {
  const [last, setLast] = useState<ScanAccepted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!flashing) return;
    const t = setTimeout(() => {
      setFlashing(false);
    }, FLASH_MS);
    return (): void => {
      clearTimeout(t);
    };
  }, [flashing, last]);

  const run = (): void => {
    setError(null);
    fetch(`/api/orchestration/scan?kind=${kind}`, { method: 'POST' })
      .then(async (r) => {
        const raw: unknown = await r.json();
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
        return ScanAcceptedSchema.parse(raw);
      })
      .then((res) => {
        setLast(res);
        setFlashing(true);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  };
  return { run, flashing, last, error };
}

function useClock(): string {
  const [iso, setIso] = useState<string>(() => formatNow());
  useEffect(() => {
    const t = setInterval(() => {
      setIso(formatNow());
    }, 1000);
    return (): void => {
      clearInterval(t);
    };
  }, []);
  return iso;
}

function formatNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} ${time}`;
}
