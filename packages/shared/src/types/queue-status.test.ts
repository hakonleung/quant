import { describe, expect, it } from 'vitest';

import {
  QueueSnapshotEntrySchema,
  QueueSnapshotSchema,
} from './queue-status.js';

describe('QueueSnapshotEntrySchema', () => {
  it('accepts a valid entry', () => {
    const ok = QueueSnapshotEntrySchema.parse({
      name: 'meta',
      pending: 0,
      inFlight: 0,
      paused: false,
    });
    expect(ok.name).toBe('meta');
  });

  it('rejects negative counts', () => {
    expect(() =>
      QueueSnapshotEntrySchema.parse({ name: 'meta', pending: -1, inFlight: 0, paused: false }),
    ).toThrow();
  });

  it('rejects empty name', () => {
    expect(() =>
      QueueSnapshotEntrySchema.parse({ name: '', pending: 0, inFlight: 0, paused: false }),
    ).toThrow();
  });

  it('rejects unknown extra keys', () => {
    expect(() =>
      QueueSnapshotEntrySchema.parse({
        name: 'meta',
        pending: 0,
        inFlight: 0,
        paused: false,
        extra: 1,
      }),
    ).toThrow();
  });
});

describe('QueueSnapshotSchema', () => {
  it('accepts a snapshot with multiple queues', () => {
    const ok = QueueSnapshotSchema.parse({
      ts: '2026-05-03T08:00:00.000Z',
      queues: [
        { name: 'meta', pending: 1, inFlight: 0, paused: false },
        { name: 'kline', pending: 3, inFlight: 2, paused: true },
      ],
      activeScans: [],
    });
    expect(ok.queues).toHaveLength(2);
    expect(ok.activeScans).toEqual([]);
  });

  it('accepts a snapshot with active scans', () => {
    const ok = QueueSnapshotSchema.parse({
      ts: '2026-05-03T08:00:00.000Z',
      queues: [],
      activeScans: ['meta'],
    });
    expect(ok.activeScans).toEqual(['meta']);
  });

  it('rejects naive timestamps without offset', () => {
    expect(() =>
      QueueSnapshotSchema.parse({ ts: '2026-05-03 08:00:00', queues: [], activeScans: [] }),
    ).toThrow();
  });
});
