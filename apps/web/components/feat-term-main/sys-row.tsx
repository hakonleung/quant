'use client';

/**
 * Mini SYS row for TERM.MAIN — a compact strip of capsules and a wall
 * clock that lives directly under the big "qX//OS_" logo.
 *
 * Mirrors the right-slot of {@link FeatSysStat}: SSE / IDB status, meta
 * / kline queue counters, JS-heap MEM (Chromium-only), and an FPS
 * counter. Hooks live inline because lifting them into a shared module
 * would be premature for two call sites with different chrome.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import {
  ScanAcceptedSchema,
  type QueueSnapshotEntry,
  type ScanKind,
} from '@quant/shared';
import { useEffect, useRef, useState } from 'react';

import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';

export function TermSysRow(): React.ReactElement {
  const stream = useQueueStream();
  const fps = useFps();
  const memMb = useMemoryMb();
  const now = useClock();
  const meta = stream.snapshot?.queues.find((q) => q.name === 'meta') ?? null;
  const kline = stream.snapshot?.queues.find((q) => q.name === 'kline') ?? null;

  const sseColor =
    stream.status === 'open' ? 'term.green' : stream.status === 'error' ? 'term.red' : 'term.amber';
  const sseGlyph = stream.status === 'open' ? '●' : stream.status === 'error' ? '✘' : '○';

  return (
    <Flex
      align="center"
      gap="18px"
      px="18px"
      py="6px"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.16em"
      color="term.ink2"
      borderBottomWidth="1px"
      borderBottomColor="term.line"
      bg="rgba(6,8,10,0.6)"
      flexShrink={0}
    >
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
      <ScanCapsule code="meta" queue={meta} kind="meta" />
      <ScanCapsule code="kline" queue={kline} kind="kline" />
      <Capsule code="MEM">
        <Text as="span" color={memColor(memMb)} fontWeight="700">
          {memMb === null ? '—' : `${String(memMb)}M`}
        </Text>
      </Capsule>
      <Capsule code="FPS">
        <Text as="span" color={fpsColor(fps)} fontWeight="700">
          {String(fps)}
        </Text>
      </Capsule>
      <Box flex="1" />
      <Text color="term.ink3" suppressHydrationWarning>
        {now}
      </Text>
    </Flex>
  );
}

function Capsule({
  code,
  children,
}: {
  code: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Flex align="center" gap="6px" whiteSpace="nowrap">
      <Text color="term.green" fontWeight="700">
        {code}
      </Text>
      {children}
    </Flex>
  );
}

function ScanCapsule({
  code,
  queue,
  kind,
}: {
  code: string;
  queue: QueueSnapshotEntry | null;
  kind: ScanKind;
}): React.ReactElement {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!flashing) return;
    const t = setTimeout(() => {
      setFlashing(false);
    }, 800);
    return () => {
      clearTimeout(t);
    };
  }, [flashing]);
  const counter = queue === null ? '—' : `${String(queue.inFlight)}/${String(queue.pending)}`;
  return (
    <Flex
      as="button"
      onClick={(): void => {
        setFlashing(true);
        void fetch(`/api/orchestration/scan?kind=${kind}`, { method: 'POST' })
          .then((r) => (r.ok ? r.json() : null))
          .then((raw: unknown): void => {
            if (raw !== null) ScanAcceptedSchema.safeParse(raw);
          })
          .catch(() => {
            /* swallow — capsule is best-effort */
          });
      }}
      align="center"
      gap="6px"
      whiteSpace="nowrap"
      bg="transparent"
      cursor="pointer"
      title={`trigger ${kind} scan`}
    >
      <Text color={flashing ? 'term.amber' : 'term.green'} fontWeight="700">
        {code}
      </Text>
      <Text as="span" color={queue === null ? 'term.ink3' : 'term.ink2'} fontWeight="700">
        {counter}
      </Text>
    </Flex>
  );
}

function useFps(): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      frames += 1;
      const elapsed = now - last;
      if (elapsed >= 1000) {
        setFps(Math.round((frames * 1000) / elapsed));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);
  return fps;
}

interface PerfMem {
  readonly usedJSHeapSize: number;
}

function useMemoryMb(): number | null {
  const [mb, setMb] = useState<number | null>(null);
  const supported = useRef(true);
  useEffect(() => {
    if (!supported.current) return;
    const sample = (): void => {
      const mem = (performance as Performance & { memory?: PerfMem }).memory;
      if (mem === undefined) {
        supported.current = false;
        setMb(null);
        return;
      }
      setMb(Math.round(mem.usedJSHeapSize / (1024 * 1024)));
    };
    sample();
    const t = setInterval(sample, 1500);
    return () => {
      clearInterval(t);
    };
  }, []);
  return mb;
}

function useClock(): string {
  // Start with an empty string on the server so SSR + first client render
  // produce identical HTML; the actual time is filled in on mount, when
  // hydration is already complete.
  const [s, setS] = useState<string>('');
  useEffect(() => {
    setS(formatNow());
    const t = setInterval(() => {
      setS(formatNow());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);
  return s;
}

function formatNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fpsColor(fps: number): string {
  if (fps === 0) return 'term.ink3';
  if (fps < 30) return 'term.red';
  if (fps < 50) return 'term.amber';
  return 'term.green';
}

function memColor(mb: number | null): string {
  if (mb === null) return 'term.ink3';
  if (mb > 800) return 'term.red';
  if (mb > 400) return 'term.amber';
  return 'term.green';
}
