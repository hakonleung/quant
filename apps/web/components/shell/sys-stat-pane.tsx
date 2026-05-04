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
 *   1. SSE   — live | connecting | lost
 *   2. IDB   — local-storage backend identifier
 *   3. meta  — `inFlight/pending` (always visible; 0/0 when idle)
 *   4. kline — `inFlight/pending`
 *   5. MEM   — used JS-heap MB (—  on non-Chromium browsers)
 *   6. FPS   — animation-frame rate (1Hz update window)
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
import { useEffect, useRef, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';
import { Pane } from './pane.js';

export function SysStatPane(): React.ReactElement {
  const stream = useQueueStream();
  const now = useClock();
  const metaScan = useManualScan('meta');
  const klineScan = useManualScan('kline');
  const fps = useFps();
  const memMb = useMemoryMb();

  const sseColor =
    stream.status === 'open' ? 'term.green' : stream.status === 'error' ? 'term.red' : 'term.amber';
  const sseGlyph = stream.status === 'open' ? '●' : stream.status === 'error' ? '✘' : '○';

  const queues: readonly QueueSnapshotEntry[] = stream.snapshot?.queues ?? [];
  const meta = queues.find((q) => q.name === 'meta') ?? null;
  const kline = queues.find((q) => q.name === 'kline') ?? null;

  return (
    <Pane
      feat={Feat.SysStat}
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
          <QueueCapsule
            code="meta"
            queue={meta}
            scan={metaScan}
            scanning={isScanning(stream.snapshot?.activeScans, 'meta')}
          />
          <QueueCapsule
            code="kline"
            queue={kline}
            scan={klineScan}
            scanning={isScanning(stream.snapshot?.activeScans, 'kline')}
          />
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
  scanning,
}: {
  code: string;
  queue: QueueSnapshotEntry | null;
  scan: ManualScan;
  scanning: boolean;
}): React.ReactElement {
  const counterColor = queue === null ? 'term.ink3' : queue.paused ? 'term.amber' : 'term.red';
  // Label highlight priority: server-confirmed scanning > local 1s
  // submit flash > idle. Server "scanning" wins because the SSE
  // payload is the truth — even if the user landed on the page
  // mid-scan (no recent click), they should see the indicator.
  const labelColor = scanning || scan.flashing ? 'term.amber' : 'term.green';
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
      title={
        scanning
          ? `${code} scan in progress (queue may not show jobs until bulk RPC finishes)`
          : `trigger ${code} scan now`
      }
    >
      <Text color={labelColor} fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      <Text as="span" color={counterColor} fontWeight="700">
        {String(queue?.inFlight ?? 0)}/{String(queue?.pending ?? 0)}
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
 * Whether the SSE-reported active-scan list covers the given queue.
 * `'all'` counts as both meta and kline since it fans out to both.
 */
function isScanning(
  activeScans: readonly ScanKind[] | undefined,
  queue: 'meta' | 'kline',
): boolean {
  if (activeScans === undefined) return false;
  return activeScans.includes(queue) || activeScans.includes('all');
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

/**
 * FPS counter — counts requestAnimationFrame ticks per second. Updates
 * once per closed window so the readout doesn't itself thrash. Returns
 * 0 until the first window closes.
 */
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

interface PerformanceMemory {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: PerformanceMemory;
}

/**
 * Used JS-heap size in MiB, polled at 1Hz. Chromium-only; returns
 * `null` on browsers without `performance.memory`.
 */
function useMemoryMb(): number | null {
  const [mb, setMb] = useState<number | null>(null);
  const supported = useRef(true);
  useEffect(() => {
    if (!supported.current) return;
    const sample = (): void => {
      const perf = performance as PerformanceWithMemory;
      const mem = perf.memory;
      if (mem === undefined) {
        supported.current = false;
        setMb(null);
        return;
      }
      setMb(Math.round(mem.usedJSHeapSize / (1024 * 1024)));
    };
    sample();
    const t = setInterval(sample, 1000);
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
