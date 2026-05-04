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

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { ScanResultSchema, type QueueSnapshotEntry, type ScanResult } from '@quant/shared';
import { useEffect, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';
import { Pane } from './pane.js';

export function Footer(): React.ReactElement {
  const stream = useQueueStream();
  const now = useClock();
  const scan = useManualScan();

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
          <QueueCapsule code="meta" queue={meta} />
          <QueueCapsule code="kline" queue={kline} />
          <Button
            onClick={(): void => {
              scan.run();
            }}
            loading={scan.pending}
            disabled={scan.pending}
            bg="transparent"
            color="term.green"
            borderWidth="1px"
            borderColor="term.green"
            h="auto"
            px="8px"
            py="2px"
            fontFamily="mono"
            fontSize="9px"
            letterSpacing="0.18em"
            fontWeight="700"
            borderRadius="0"
            _hover={{ bg: 'term.green', color: 'term.panel' }}
            title="trigger meta+kline scan now"
          >
            ⟳ SCAN
          </Button>
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
          {scan.last !== null && (
            <Text color="term.ink3">
              // last scan {scan.last.startedAt.slice(11, 19)} · meta+
              {String(scan.last.metaEnqueued)} kline+{String(scan.last.klineEnqueued)} ·{' '}
              {String(scan.last.elapsedMs)}ms
            </Text>
          )}
          {scan.error !== null && <Text color="term.red">// scan: {scan.error}</Text>}
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
}: {
  code: string;
  queue: QueueSnapshotEntry | null;
}): React.ReactElement | null {
  if (queue === null) return null;
  // Hide queue capsules when there's nothing in flight or pending —
  // keeps the header quiet when the system is idle.
  if (queue.inFlight === 0 && queue.pending === 0) return null;
  const color = queue.paused ? 'term.amber' : 'term.red';
  return (
    <Capsule code={code}>
      <Text as="span" color={color} fontWeight="700">
        {String(queue.inFlight)}/{String(queue.pending)}
      </Text>
    </Capsule>
  );
}

interface ManualScan {
  readonly run: () => void;
  readonly pending: boolean;
  readonly last: ScanResult | null;
  readonly error: string | null;
}

function useManualScan(): ManualScan {
  const [pending, setPending] = useState(false);
  const [last, setLast] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    if (pending) return;
    setPending(true);
    setError(null);
    fetch('/api/orchestration/scan', { method: 'POST' })
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
