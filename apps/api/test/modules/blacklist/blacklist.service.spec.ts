import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  BlacklistService,
  decodeDateCell,
} from '../../../src/modules/blacklist/blacklist.service.js';
import {
  BLACKLIST_TABLE_SPEC,
  BlacklistStore,
  type BlacklistRow,
} from '../../../src/modules/blacklist/blacklist.store.js';
import { FrozenClock } from '../../../src/common/clock.js';
import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

function makeBlacklistStore(dir: string): BlacklistStore {
  return new BlacklistStore(new InMemoryRecordStore<BlacklistRow>(BLACKLIST_TABLE_SPEC), dir);
}

interface FakeProxy {
  toJSON(): Record<string, unknown>;
}

class FakeTable {
  constructor(private readonly rows: ReadonlyArray<Record<string, unknown>>) {}
  get numRows(): number {
    return this.rows.length;
  }
  get(i: number): FakeProxy | null {
    const row = this.rows[i];
    if (row === undefined) return null;
    return { toJSON: () => row };
  }
}

function fakeFlight(rows: ReadonlyArray<Record<string, unknown>>): FlightClient {
  const table = new FakeTable(rows);
  return {
    doGet: async (_op: string, _args: unknown, _opts: unknown): Promise<{ value: FakeTable }> => ({
      value: table,
    }),
  } as unknown as FlightClient;
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'blacklist-svc-'));
}

const FROZEN = new Date('2026-05-04T07:15:00.000Z');

describe('decodeDateCell', () => {
  it('decodes a Date instance', () => {
    expect(decodeDateCell(new Date('2026-05-04T00:00:00Z'))).toBe('2026-05-04');
  });
  it('returns the leading 10 chars of an ISO string', () => {
    expect(decodeDateCell('2026-05-04T13:30:00Z')).toBe('2026-05-04');
  });
  it('treats a number > 1e8 as ms since epoch', () => {
    const ms = Date.UTC(2026, 4, 4); // 1779494400000 (months are 0-indexed)
    expect(decodeDateCell(ms)).toBe('2026-05-04');
  });
  it('treats a small number as days since epoch', () => {
    const days = Math.floor(Date.UTC(2026, 4, 4) / 86_400_000); // 20577
    expect(decodeDateCell(days)).toBe('2026-05-04');
  });
  it('handles bigint via the number branch', () => {
    const ms = BigInt(Date.UTC(2026, 4, 4));
    expect(decodeDateCell(ms)).toBe('2026-05-04');
  });
  it('returns null for null / undefined', () => {
    expect(decodeDateCell(null)).toBeNull();
    expect(decodeDateCell(undefined)).toBeNull();
  });
  it('returns null for unsupported types', () => {
    expect(decodeDateCell({})).toBeNull();
    expect(decodeDateCell(true)).toBeNull();
  });
});

describe('BlacklistService.refresh', () => {
  it('writes EMPTY_BLACKLIST codes when the Flight table is empty', async () => {
    const dir = await tmpDir();
    const store = makeBlacklistStore(dir);
    await store.load();
    const svc = new BlacklistService(store, fakeFlight([]), new FrozenClock(FROZEN));

    const snap = await svc.refresh('trace-1');

    expect(snap.codes).toEqual([]);
    expect(snap.computedAt).toBe(FROZEN.toISOString());
    expect(store.snapshot()).toEqual(snap);
  });

  it('parses code/asof/universe_size from a populated table', async () => {
    const dir = await tmpDir();
    const store = makeBlacklistStore(dir);
    await store.load();
    const rows = [
      { code: '000001', asof: '2026-05-04', universe_size: 5500 },
      { code: '600519', asof: '2026-05-04', universe_size: 5500 },
    ];
    const svc = new BlacklistService(store, fakeFlight(rows), new FrozenClock(FROZEN));

    const snap = await svc.refresh('trace-2');

    expect(snap.codes).toEqual(['000001', '600519']);
    expect(snap.asof).toBe('2026-05-04');
    expect(snap.universeSize).toBe(5500);
    expect(snap.computedAt).toBe(FROZEN.toISOString());
    expect(store.has('000001')).toBe(true);
  });

  it('skips rows whose code is not a string', async () => {
    const dir = await tmpDir();
    const store = makeBlacklistStore(dir);
    await store.load();
    const rows = [
      { code: 12345, asof: '2026-05-04', universe_size: 1 },
      { code: '000002', asof: '2026-05-04', universe_size: 1 },
    ];
    const svc = new BlacklistService(store, fakeFlight(rows), new FrozenClock(FROZEN));

    const snap = await svc.refresh('trace-3');

    expect(snap.codes).toEqual(['000002']);
  });

  it('falls back to EMPTY_BLACKLIST.asof when the first row carries an unparseable asof', async () => {
    const dir = await tmpDir();
    const store = makeBlacklistStore(dir);
    await store.load();
    const rows = [{ code: '000001', asof: { weird: 'object' }, universe_size: 1 }];
    const svc = new BlacklistService(store, fakeFlight(rows), new FrozenClock(FROZEN));

    const snap = await svc.refresh('trace-4');

    expect(snap.asof).toBe('1970-01-01');
    expect(snap.codes).toEqual(['000001']);
  });

  it('uses the injected clock for computedAt — never `new Date()`', async () => {
    const dir = await tmpDir();
    const store = makeBlacklistStore(dir);
    await store.load();
    const a = new Date('2026-01-01T00:00:00Z');
    const b = new Date('2026-12-31T23:59:59Z');
    const svcA = new BlacklistService(store, fakeFlight([]), new FrozenClock(a));
    const svcB = new BlacklistService(store, fakeFlight([]), new FrozenClock(b));

    const snapA = await svcA.refresh('t-a');
    const snapB = await svcB.refresh('t-b');

    expect(snapA.computedAt).toBe(a.toISOString());
    expect(snapB.computedAt).toBe(b.toISOString());
  });
});
