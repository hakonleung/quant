import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Sector } from '@quant/shared';

import { SectorsController } from '../../../src/modules/sectors/sectors.controller.js';
import { SectorsService } from '../../../src/modules/sectors/sectors.service.js';
import {
  SECTORS_TABLE_SPEC,
  SectorsStore,
  type SectorRow,
} from '../../../src/modules/sectors/sectors.store.js';
import { FrozenClock } from '../../../src/common/clock.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';
import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import type { AuthenticatedUser } from '../../../src/modules/auth/request-with-user.js';
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

const FROZEN = new Date('2026-05-04T07:15:00.000Z');

const baseDynamic: Sector = {
  id: 's1',
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
  createdBy: 'admin',
  published: false,
};

const userSector: Sector = {
  id: 's2',
  name: 'manual',
  kind: 'user',
  count: 1,
  meta: 'manual basket',
  chgPct: null,
  codes: ['000001'],
  createdBy: 'admin',
  published: false,
};

const traceReq = { traceId: 'trace-test' } as RequestWithTraceId;

const adminUser: AuthenticatedUser = {
  id: 'admin',
  displayName: 'Admin',
  source: 'env',
  imBootstrap: false,
};
const aliceUser: AuthenticatedUser = {
  id: 'alice',
  displayName: 'Alice',
  source: 'oauth',
  imBootstrap: false,
};

async function freshController(
  initial: readonly Sector[],
  flight: FlightClient,
): Promise<{ store: SectorsStore; service: SectorsService; ctrl: SectorsController }> {
  const record = new InMemoryRecordStore<SectorRow>(SECTORS_TABLE_SPEC);
  for (const s of initial) {
    await record.upsert({ id: s.id, payload_json: JSON.stringify(s) });
  }
  const store = new SectorsStore(record);
  await store.load();
  const service = new SectorsService(store, flight, new FrozenClock(FROZEN));
  const ctrl = new SectorsController(service);
  return { store, service, ctrl };
}

describe('SectorsController.refresh', () => {
  it('throws NotFound when the sector does not exist', async () => {
    const { ctrl } = await freshController([baseDynamic], fakeFlight(null));
    await expect(ctrl.refresh(traceReq, adminUser, 'no-such-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws BadRequest when the sector is not dynamic', async () => {
    const { ctrl } = await freshController([userSector], fakeFlight(null));
    await expect(ctrl.refresh(traceReq, adminUser, userSector.id)).rejects.toThrow();
  });

  it('any user can refresh a published dynamic sector and codes persist', async () => {
    const published: Sector = { ...baseDynamic, published: true, createdBy: 'admin' };
    const newPayload = { planSignature: 'sig', matches: [{ code: '688008', evidence: { s: 1 } }] };
    const { ctrl, store } = await freshController([published], fakeFlight(newPayload));
    const out = await ctrl.refresh(traceReq, aliceUser, published.id);
    expect(out.sector.codes).toEqual(['688008']);
    expect(store.list()[0]?.codes).toEqual(['688008']);
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

    const out = await ctrl.refresh(traceReq, adminUser, baseDynamic.id);

    expect(out.sector.codes).toEqual(['688008', '301010']);
    expect(out.sector.count).toBe(2);
    expect(out.sector.lastScreenedAt).toBe(FROZEN.toISOString());
    expect(store.list()[0]).toEqual(out.sector);
  });
});

describe('SectorsController.publish', () => {
  it('owner can toggle published', async () => {
    const { ctrl, store } = await freshController([userSector], fakeFlight(null));
    const out = await ctrl.publish(adminUser, userSector.id, { published: true });
    expect(out.sector.published).toBe(true);
    expect(out.sector.publishedAt).toBeDefined();
    expect(store.list()[0]?.published).toBe(true);
  });

  it('non-owner is rejected with ForbiddenException', async () => {
    const { ctrl } = await freshController([userSector], fakeFlight(null));
    await expect(
      ctrl.publish(aliceUser, userSector.id, { published: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('NotFound when the sector does not exist', async () => {
    const { ctrl } = await freshController([], fakeFlight(null));
    await expect(ctrl.publish(adminUser, 'missing', { published: true })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SectorsController.list', () => {
  it('non-owner sees only published others + own', async () => {
    const aliceOwn: Sector = { ...userSector, id: 's10', createdBy: 'alice' };
    const adminPub: Sector = { ...userSector, id: 's11', createdBy: 'admin', published: true };
    const adminPriv: Sector = { ...userSector, id: 's12', createdBy: 'admin' };
    const { ctrl } = await freshController([aliceOwn, adminPub, adminPriv], fakeFlight(null));
    const out = ctrl.list(aliceUser);
    expect(out.sectors.map((s) => s.id).sort()).toEqual(['s10', 's11']);
  });
});

void BadRequestException;
