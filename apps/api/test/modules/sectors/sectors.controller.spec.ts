import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Sector } from '@quant/shared';

import { SectorsController } from '../../../src/modules/sectors/sectors.controller.js';
import { SectorsStore } from '../../../src/modules/sectors/sectors.store.js';
import { FrozenClock } from '../../../src/common/clock.js';
import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import type { RequestWithTraceId } from '../../../src/common/trace.middleware.js';

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

function fakeFlight(payload: unknown | null): FlightClient {
  const rows = payload === null ? [] : [{ payload_json: JSON.stringify(payload) }];
  const table = new FakeTable(rows);
  return {
    doGet: async (_op: string, _args: unknown, _opts: unknown): Promise<{ value: FakeTable }> => ({
      value: table,
    }),
  } as unknown as FlightClient;
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sectors-ctrl-'));
}

const FROZEN = new Date('2026-05-04T07:15:00.000Z');

const baseDynamic: Sector = {
  id: 'dyn-abc123',
  name: '90日龙头',
  kind: 'dynamic',
  count: 2,
  meta: '股价高于3个月最高价的90%',
  chgPct: null,
  codes: ['600519', '300750'],
  nl: '股价高于3个月最高价的90%',
  evidence: { '600519': { foo: 1 }, '300750': { foo: 2 } },
  screenPlan: {
    asof: '2026-05-04',
    expr: { kind: 'logical', op: 'and', args: [] },
  },
  universePlan: null,
  rank: null,
};

const userSector: Sector = {
  id: 'user-x',
  name: 'manual',
  kind: 'user',
  count: 1,
  meta: 'manual basket',
  chgPct: null,
  codes: ['000001'],
};

const traceReq = { traceId: 'trace-test' } as RequestWithTraceId;

async function freshController(
  initial: readonly Sector[],
  flight: FlightClient,
): Promise<{ store: SectorsStore; ctrl: SectorsController }> {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'sectors.json'), JSON.stringify(initial));
  const store = new SectorsStore(dir);
  await store.load();
  const ctrl = new SectorsController(store, flight, new FrozenClock(FROZEN));
  return { store, ctrl };
}

describe('SectorsController.refresh', () => {
  it('throws NotFound when the sector does not exist', async () => {
    const { ctrl } = await freshController([baseDynamic], fakeFlight(null));
    await expect(ctrl.refresh(traceReq, 'no-such-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequest when the sector is not dynamic', async () => {
    const { ctrl } = await freshController([userSector], fakeFlight(null));
    await expect(ctrl.refresh(traceReq, userSector.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws BadRequest when the dynamic sector has no screenPlan', async () => {
    const noPlan: Sector = { ...baseDynamic, screenPlan: undefined };
    const { ctrl } = await freshController([noPlan], fakeFlight(null));
    await expect(ctrl.refresh(traceReq, noPlan.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws BadRequest when screen_run returns an empty payload', async () => {
    const { ctrl } = await freshController([baseDynamic], fakeFlight(null));
    await expect(ctrl.refresh(traceReq, baseDynamic.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('replaces codes / evidence and stamps lastScreenedAt from the injected clock', async () => {
    const newPayload = {
      planSignature: 'sig-abc',
      matches: [
        { code: '688008', evidence: { score: 0.9 } },
        { code: '301010', evidence: { score: 0.8 } },
      ],
    };
    const { store, ctrl } = await freshController([baseDynamic], fakeFlight(newPayload));

    const out = await ctrl.refresh(traceReq, baseDynamic.id);

    expect(out.sector.codes).toEqual(['688008', '301010']);
    expect(out.sector.count).toBe(2);
    expect(out.sector.evidence).toEqual({
      '688008': { score: 0.9 },
      '301010': { score: 0.8 },
    });
    expect(out.sector.lastScreenedAt).toBe(FROZEN.toISOString());
    // store has been updated atomically.
    expect(store.list()[0]).toEqual(out.sector);
  });

  it('preserves nl / screenPlan / rank when refreshing', async () => {
    const newPayload = { planSignature: 'sig-x', matches: [] };
    const { ctrl } = await freshController([baseDynamic], fakeFlight(newPayload));

    const out = await ctrl.refresh(traceReq, baseDynamic.id);

    expect(out.sector.nl).toBe(baseDynamic.nl);
    expect(out.sector.screenPlan).toEqual(baseDynamic.screenPlan);
    expect(out.sector.codes).toEqual([]);
    expect(out.sector.count).toBe(0);
  });
});

describe('SectorsStore.upsert', () => {
  it('updates an existing sector in-place (preserving position)', async () => {
    const dir = await tmpDir();
    const a: Sector = { ...userSector, id: 'a' };
    const b: Sector = { ...userSector, id: 'b' };
    const c: Sector = { ...userSector, id: 'c' };
    await fs.writeFile(path.join(dir, 'sectors.json'), JSON.stringify([a, b, c]));
    const store = new SectorsStore(dir);
    await store.load();

    const updatedB: Sector = { ...b, name: 'mutated' };
    await store.upsert(updatedB);

    const list = store.list();
    expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(list[1]?.name).toBe('mutated');
  });

  it('appends a new sector when id is unseen', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'sectors.json'), JSON.stringify([userSector]));
    const store = new SectorsStore(dir);
    await store.load();

    const fresh: Sector = { ...userSector, id: 'fresh' };
    await store.upsert(fresh);

    const list = store.list();
    expect(list.map((s) => s.id)).toEqual([userSector.id, 'fresh']);
  });

  it('writes the change to disk atomically', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'sectors.json'), JSON.stringify([userSector]));
    const store = new SectorsStore(dir);
    await store.load();

    const fresh: Sector = { ...userSector, id: 'fresh', name: 'on-disk' };
    await store.upsert(fresh);

    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, 'sectors.json'), 'utf8'),
    ) as Sector[];
    expect(onDisk.map((s) => s.id)).toEqual([userSector.id, 'fresh']);
    expect(onDisk[1]?.name).toBe('on-disk');
  });
});
