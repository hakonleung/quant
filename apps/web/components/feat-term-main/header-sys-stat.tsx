'use client';

/**
 * Vertical SYS.STAT block for the TERM.MAIN header — replaces the
 * earlier `MetaBlock` (kernel/boot/uptime). Right-aligned, four lines:
 *
 *   meta   inFlight/pending           (read-only indicator)
 *   kline  inFlight/pending           (read-only indicator)
 *   MEM    JS-heap MB
 *   FPS    requestAnimationFrame rate
 *
 * Mirrors the data sources of `feat-sys-stat` so the two panes stay in
 * lockstep, but lays the capsules out vertically (the user explicitly
 * requested 纵向 / vertical). Hooks live inline because the call site
 * is single-purpose.
 *
 * Term mode is intentionally keyboard-only — these capsules are
 * informational; trigger a scan via the `update` command at the
 * prompt instead.
 */

import { Flex, Text } from '@chakra-ui/react';
import { type QueueSnapshotEntry } from '@quant/shared';
import { useEffect, useRef, useState } from 'react';

import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';

export function HeaderSysStat(): React.ReactElement {
  const stream = useQueueStream();
  const fps = useFps();
  const memMb = useMemoryMb();
  const meta = stream.snapshot?.queues.find((q) => q.name === 'meta') ?? null;
  const kline = stream.snapshot?.queues.find((q) => q.name === 'kline') ?? null;

  return (
    <Flex
      direction="column"
      align="flex-end"
      gap="3px"
      fontFamily="mono"
      fontSize="11px"
      letterSpacing="0.16em"
      color="term.ink2"
    >
      <ScanLine code="meta" queue={meta} />
      <ScanLine code="kline" queue={kline} />
      <ValueLine
        code="MEM"
        value={memMb === null ? '—' : `${String(memMb)}M`}
        color={memColor(memMb)}
      />
      <ValueLine code="FPS" value={String(fps)} color={fpsColor(fps)} />
    </Flex>
  );
}

function ValueLine({
  code,
  value,
  color,
}: {
  code: string;
  value: string;
  color: string;
}): React.ReactElement {
  return (
    <Flex gap="8px" align="baseline" justify="flex-end" minW="120px">
      <Text color="term.green" fontWeight="700">
        {code}
      </Text>
      <Text color={color} fontWeight="700">
        {value}
      </Text>
    </Flex>
  );
}

function ScanLine({
  code,
  queue,
}: {
  code: string;
  queue: QueueSnapshotEntry | null;
}): React.ReactElement {
  const counter = queue === null ? '—' : `${String(queue.inFlight)}/${String(queue.pending)}`;
  return (
    <Flex gap="8px" align="baseline" justify="flex-end" minW="120px">
      <Text color="term.green" fontWeight="700">
        {code}
      </Text>
      <Text color={queue === null ? 'term.ink3' : 'term.ink2'} fontWeight="700">
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
