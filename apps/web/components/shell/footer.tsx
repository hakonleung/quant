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
 *   3. meta  — `inFlight/pending` (omitted when both are 0)
 *   4. kline — `inFlight/pending` (omitted when both are 0)
 *
 * Body carries the wall clock and additional debug info.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import {
  ScanResultSchema,
  type QueueSnapshotEntry,
  type ScanKind,
  type ScanResult,
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
  // The capsule label is itself the trigger — click `META` / `KLINE`
  // to fire that kind's scan. Renders a dim "·" when the queue has no
  // pending/in-flight work, the live counter otherwise.
  const idle = queue === null || (queue.inFlight === 0 && queue.pending === 0);
  const counterColor =
    queue === null ? 'term.ink3' : queue.paused ? 'term.amber' : 'term.red';
  const labelColor = scan.pending ? 'term.amber' : 'term.green';
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
      cursor={scan.pending ? 'wait' : 'pointer'}
      opacity={scan.pending ? 0.6 : 1}
      _hover={scan.pending ? {} : { color: 'term.green' }}
      title={`trigger ${code} scan now`}
    >
      <Text color={labelColor} fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      {idle ? (
        <Text as="span" color="term.ink3">
          ·
        </Text>
      ) : (
        <Text as="span" color={counterColor} fontWeight="700">
          {String(queue?.inFlight ?? 0)}/{String(queue?.pending ?? 0)}
        </Text>
      )}
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
  if (scan.pending) {
    return <Text color="term.amber">// {label}: scanning…</Text>;
  }
  if (scan.error !== null) {
    return (
      <Text color="term.red">
        // {label}: {scan.error}
      </Text>
    );
  }
  if (scan.last === null) return null;
  const enqueued =
    label === 'meta' ? scan.last.metaEnqueued : scan.last.klineEnqueued;
  return (
    <Text color="term.ink3">
      // {label}: {scan.last.startedAt.slice(11, 19)} +{String(enqueued)} ·{' '}
      {String(scan.last.elapsedMs)}ms
    </Text>
  );
}

interface ManualScan {
  readonly run: () => void;
  readonly pending: boolean;
  readonly last: ScanResult | null;
  readonly error: string | null;
}

function useManualScan(kind: ScanKind): ManualScan {
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    if (pending) return;
    setPending(true);
    setError(null);
    fetch(`/api/orchestration/scan?kind=${kind}`, { method: 'POST' })
      .then(async (r) => {
        const raw: unknown = await r.json();
        if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
        return ScanResultSchema.parse(raw);
      })
      .then((res) => {
        setLast(res);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setPending(false);
      });
  };
  return { run, pending, last, error };
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
