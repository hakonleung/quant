import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LedgerAnalysis, LedgerEntry } from '@quant/shared';

import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import { FrozenClock } from '../../../src/common/clock.js';
import { LedgerCacheStore } from '../../../src/modules/ledger/ledger-cache.store.js';
import { LedgerService } from '../../../src/modules/ledger/ledger.service.js';
import { LedgerStore } from '../../../src/modules/ledger/ledger.store.js';

const FROZEN = new Date('2026-05-08T00:00:00.000Z');

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

function fakeFlight(rows: ReadonlyArray<Record<string, unknown>>): {
  flight: FlightClient;
  calls: { op: string; args: unknown }[];
} {
  const calls: { op: string; args: unknown }[] = [];
  const table = new FakeTable(rows);
  const flight = {
    doGet: async (op: string, args: unknown): Promise<{ value: FakeTable }> => {
      calls.push({ op, args });
      return { value: table };
    },
  } as unknown as FlightClient;
  return { flight, calls };
}

const SAMPLE_ANALYSIS: LedgerAnalysis = {
  summary: '过去三日整体小幅盈利',
  operationStyle: '稳健加减仓',
  marketView: '震荡偏强',
  recommendations: ['保持当前仓位'],
  generatedAt: '2026-05-08T00:00:00.000+00:00',
  windowStart: '2026-05-01',
  windowEnd: '2026-05-03',
  entryCount: 3,
  provider: 'moonshot',
};

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function setup(seed: readonly LedgerEntry[] = []): Promise<{
  store: LedgerStore;
  cache: LedgerCacheStore;
  dir: string;
}> {
  const dir = await tmpDir('ledger-svc-');
  if (seed.length > 0) {
    await fs.writeFile(path.join(dir, 'entries.json'), JSON.stringify({ entries: seed }));
  }
  const store = new LedgerStore(dir);
  const cache = new LedgerCacheStore(dir);
  await store.load();
  await cache.load();
  return { store, cache, dir };
}

describe('LedgerService.create', () => {
  it('rejects duplicate dates', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await expect(
      svc.create({ date: '2026-05-01', pnlAmount: '5', closingPosition: '100050' }),
    ).rejects.toMatchObject({ code: 'LEDGER_DUPLICATE_DATE' });
  });

  it('rejects when first entry has no closingPosition', async () => {
    const { store, cache } = await setup();
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await expect(svc.create({ date: '2026-05-01', pnlAmount: '5' })).rejects.toMatchObject({
      code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
    });
  });

  it('accepts a non-anchor entry without closingPosition once an anchor exists', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await svc.create({ date: '2026-05-02', pnlAmount: '500' });
    await store.flushNow();
    expect(svc.list().map((e) => e.date)).toEqual(['2026-05-01', '2026-05-02']);
  });
});

describe('LedgerService.patch', () => {
  it('updates pnlAmount on an existing entry', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    const next = await svc.patch('2026-05-02', { pnlAmount: '700' });
    expect(next.pnlAmount).toBe('700');
  });

  it('throws NOT_FOUND for an unknown date', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await expect(svc.patch('2099-12-31', { pnlAmount: '0' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('clears closingPosition when caller passes null', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500', closingPosition: '100500' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    const next = await svc.patch('2026-05-02', { closingPosition: null });
    expect(next.closingPosition).toBeNull();
  });
});

describe('LedgerService.remove', () => {
  it('rejects when removing the anchor exposes a non-anchor next entry', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await expect(svc.remove('2026-05-01')).rejects.toMatchObject({
      code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
    });
  });

  it('removes a non-anchor entry without complaint', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await svc.remove('2026-05-02');
    expect(svc.list().map((e) => e.date)).toEqual(['2026-05-01']);
  });
});

describe('LedgerService.importEntries', () => {
  it('imported entries overwrite existing dates', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await svc.importEntries([{ date: '2026-05-02', pnlAmount: '999' }]);
    expect(svc.list().find((e) => e.date === '2026-05-02')?.pnlAmount).toBe('999');
  });
});

describe('LedgerService.analyze', () => {
  it('returns cached payload without calling Flight when warm', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { flight, calls } = fakeFlight([{ payload_json: JSON.stringify(SAMPLE_ANALYSIS) }]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));

    const first = await svc.analyze('t-1');
    const second = await svc.analyze('t-2');

    expect(first).toEqual(SAMPLE_ANALYSIS);
    expect(second).toEqual(SAMPLE_ANALYSIS);
    expect(calls.length).toBe(1);
  });

  it('forces a fresh call when bypassCache is true', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { flight, calls } = fakeFlight([{ payload_json: JSON.stringify(SAMPLE_ANALYSIS) }]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));

    await svc.analyze('t-1');
    await svc.analyze('t-2', true);

    expect(calls.length).toBe(2);
  });

  it('throws LLM_FAILED when the ledger is empty', async () => {
    const { store, cache } = await setup();
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await expect(svc.analyze('t-1')).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });

  it('throws LLM_FAILED when Flight returns no rows', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { flight } = fakeFlight([]);
    const svc = new LedgerService(store, cache, flight, new FrozenClock(FROZEN));
    await expect(svc.analyze('t-1')).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });
});
