/**
 * Pure helpers for the SYS.STAT capsule strip + clock readout. Kept
 * here so the React component file stays under the 400-line ceiling
 * (CLAUDE.md §1.2) and so colour / label policy is unit-testable
 * without a DOM (CLAUDE.md §2.5.1 — pure-function core asset).
 */

import type { QueueSnapshotEntry, ScanKind } from '@quant/shared';

export type WsStatus = 'connecting' | 'open' | 'error';

export interface WsAppearance {
  readonly color: string;
  readonly glyph: string;
}

export function wsAppearance(status: WsStatus): WsAppearance {
  if (status === 'open') return { color: 'term.green', glyph: '●' };
  if (status === 'error') return { color: 'term.red', glyph: '✘' };
  return { color: 'term.amber', glyph: '○' };
}

/** Look up a queue entry by name; returns null when the stream snapshot
 *  hasn't reported it yet (server still warming up). */
export function findQueue(
  queues: readonly QueueSnapshotEntry[],
  name: string,
): QueueSnapshotEntry | null {
  return queues.find((q) => q.name === name) ?? null;
}

/**
 * Whether the socket-reported active-scan list covers `needle`.
 * `'all'` fans out to every concrete kind (meta / kline / blacklist).
 */
export function isScanCovering(
  activeScans: readonly ScanKind[] | undefined,
  needle: ScanKind,
): boolean {
  if (activeScans === undefined) return false;
  return activeScans.includes(needle) || activeScans.includes('all');
}

export function queueCounterColor(queue: QueueSnapshotEntry | null): string {
  if (queue === null) return 'term.ink3';
  return queue.paused ? 'term.amber' : 'term.red';
}

/** Server-confirmed scanning > local 1 s submit flash > idle. */
export function scanLabelColor(scanning: boolean, flashing: boolean): string {
  return scanning || flashing ? 'term.amber' : 'term.green';
}

export function queueCapsuleTitle(code: string, scanning: boolean): string {
  return scanning
    ? `${code} scan in progress (queue may not show jobs until bulk RPC finishes)`
    : `trigger ${code} scan now`;
}

export function triggerCapsuleTitle(code: string, scanning: boolean): string {
  return scanning ? `${code} scan in progress` : `trigger ${code} scan now`;
}

export function formatQueueCounter(queue: QueueSnapshotEntry | null): string {
  return `${String(queue?.inFlight ?? 0)}/${String(queue?.pending ?? 0)}`;
}

/**
 * Wall-clock formatter — pure, takes the clock-source as input so the
 * `useClock` hook can keep `Date` confined to a single eslint-disable
 * boundary at the runtime edge.
 */
export function formatClock(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date} ${time}`;
}

export function fpsColor(fps: number): string {
  if (fps === 0) return 'term.ink3';
  if (fps < 30) return 'term.red';
  if (fps < 50) return 'term.amber';
  return 'term.green';
}

export function memColor(mb: number | null): string {
  if (mb === null) return 'term.ink3';
  if (mb > 800) return 'term.red';
  if (mb > 400) return 'term.amber';
  return 'term.green';
}

export function formatMemMb(mb: number | null): string {
  return mb === null ? '—' : `${String(mb)}M`;
}
