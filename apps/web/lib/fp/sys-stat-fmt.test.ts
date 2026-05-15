/* eslint-disable no-restricted-globals -- formatClock is the unit under
 * test, so the test must construct Date inputs. The tested function is
 * pure (takes Date as a parameter); only this test file touches Date. */
import type { QueueSnapshotEntry } from '@quant/shared';
import { describe, expect, it } from 'vitest';

import {
  findQueue,
  fpsColor,
  formatClock,
  formatMemMb,
  formatQueueCounter,
  memColor,
  queueCounterColor,
  scanLabelColor,
  triggerCapsuleTitle,
  wsAppearance,
} from './sys-stat-fmt.js';

const queue = (over: Partial<QueueSnapshotEntry> = {}): QueueSnapshotEntry => ({
  name: 'meta',
  inFlight: 0,
  pending: 0,
  paused: false,
  ...over,
});

describe('wsAppearance', () => {
  it('open → green dot', () => {
    expect(wsAppearance('open')).toEqual({ color: 'term.green', glyph: '●' });
  });
  it('error → red cross', () => {
    expect(wsAppearance('error')).toEqual({ color: 'term.red', glyph: '✘' });
  });
  it('connecting → amber ring', () => {
    expect(wsAppearance('connecting')).toEqual({ color: 'term.amber', glyph: '○' });
  });
});

describe('findQueue', () => {
  it('returns the matching entry', () => {
    const a = queue({ name: 'meta' });
    const b = queue({ name: 'kline' });
    expect(findQueue([a, b], 'kline')).toBe(b);
  });
  it('returns null when missing', () => {
    expect(findQueue([queue({ name: 'meta' })], 'kline')).toBeNull();
  });
  it('returns null on empty list', () => {
    expect(findQueue([], 'meta')).toBeNull();
  });
});

describe('queueCounterColor', () => {
  it('null queue → ink3', () => {
    expect(queueCounterColor(null)).toBe('term.ink3');
  });
  it('paused → amber', () => {
    expect(queueCounterColor(queue({ paused: true }))).toBe('term.amber');
  });
  it('active → red (signals active load)', () => {
    expect(queueCounterColor(queue({ paused: false }))).toBe('term.red');
  });
});

describe('scanLabelColor', () => {
  it('idle → green', () => {
    expect(scanLabelColor(false, false)).toBe('term.green');
  });
  it('flash only → amber', () => {
    expect(scanLabelColor(false, true)).toBe('term.amber');
  });
  it('server scanning → amber (overrides idle flash)', () => {
    expect(scanLabelColor(true, false)).toBe('term.amber');
  });
  it('both → still amber', () => {
    expect(scanLabelColor(true, true)).toBe('term.amber');
  });
});

describe('capsule titles', () => {
  it('triggerCapsuleTitle scanning vs idle', () => {
    expect(triggerCapsuleTitle('SCAN', true)).toBe('SCAN scan in progress');
    expect(triggerCapsuleTitle('SCAN', false)).toBe('trigger SCAN scan now');
  });
});

describe('formatQueueCounter', () => {
  it('null → 0/0', () => {
    expect(formatQueueCounter(null)).toBe('0/0');
  });
  it('renders inFlight/pending', () => {
    expect(formatQueueCounter(queue({ inFlight: 3, pending: 7 }))).toBe('3/7');
  });
});

describe('formatClock', () => {
  it('zero-pads month/day/hour/minute/second', () => {
    const d = new Date(Date.UTC(2026, 0, 5, 4, 3, 2));
    // Convert UTC to a stable readable value via getUTC* equivalents — but
    // formatClock uses local time. Use a Date constructed with locale
    // components so the test is deterministic regardless of TZ.
    const local = new Date(2026, 0, 5, 4, 3, 2);
    expect(formatClock(local)).toBe('2026-01-05 04:03:02');
    expect(d.getUTCFullYear()).toBe(2026); // sanity
  });

  it('handles two-digit components without padding regression', () => {
    const local = new Date(2026, 11, 31, 23, 59, 58);
    expect(formatClock(local)).toBe('2026-12-31 23:59:58');
  });
});

describe('fpsColor', () => {
  it('0 → ink3 (no sample)', () => {
    expect(fpsColor(0)).toBe('term.ink3');
  });
  it('< 30 → red', () => {
    expect(fpsColor(29)).toBe('term.red');
    expect(fpsColor(1)).toBe('term.red');
  });
  it('30-49 → amber', () => {
    expect(fpsColor(30)).toBe('term.amber');
    expect(fpsColor(49)).toBe('term.amber');
  });
  it('>= 50 → green', () => {
    expect(fpsColor(50)).toBe('term.green');
    expect(fpsColor(120)).toBe('term.green');
  });
});

describe('memColor', () => {
  it('null → ink3', () => {
    expect(memColor(null)).toBe('term.ink3');
  });
  it('<= 400 → green', () => {
    expect(memColor(0)).toBe('term.green');
    expect(memColor(400)).toBe('term.green');
  });
  it('401-800 → amber', () => {
    expect(memColor(401)).toBe('term.amber');
    expect(memColor(800)).toBe('term.amber');
  });
  it('> 800 → red', () => {
    expect(memColor(801)).toBe('term.red');
  });
});

describe('formatMemMb', () => {
  it('null → em-dash', () => {
    expect(formatMemMb(null)).toBe('—');
  });
  it('renders integer MB suffix', () => {
    expect(formatMemMb(0)).toBe('0M');
    expect(formatMemMb(123)).toBe('123M');
  });
});
