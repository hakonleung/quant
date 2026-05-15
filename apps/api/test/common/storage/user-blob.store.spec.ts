import {
  USER_BLOB_TABLE_SPEC,
  UserBlobStore,
  parseLedgerSlice,
  parseWatchSlice,
  parseWatchGroupsArray,
  buildWatchSlice,
  type UserBlobRow,
} from '../../../src/common/storage/user-blob.store.js';
import {
  EMPTY_USER_BLOB,
  EMPTY_WATCH_TASK_FILE,
  USER_BLOB_SCHEMA_VERSION,
  type UserBlob,
} from '../../../src/common/storage/user-blob.types.js';
import {
  DEFAULT_SYS_CFG,
  type LedgerEntry,
  type WatchCondition,
  type WatchGroup,
  type WatchTask,
} from '@quant/shared';
import { InMemoryUserScopedRecordStore } from '../../fakes/in-memory-user-scoped-record.store.js';

const USER = 'u1';
const NOW_ISO = '2026-05-15T00:00:00.000Z';
const sampleCondition: WatchCondition = {
  kind: 'pct',
  op: 'gte',
  baseline: 'prev_close',
  thresholdPct: '5.0',
};

function makeStore(opts: {
  legacy?: () => Promise<Partial<UserBlob>>;
} = {}): {
  store: UserBlobStore;
  inner: InMemoryUserScopedRecordStore<UserBlobRow>;
} {
  const inner = new InMemoryUserScopedRecordStore<UserBlobRow>(USER_BLOB_TABLE_SPEC);
  const store = new UserBlobStore({
    dataRoot: '/unused',
    inner,
    ...(opts.legacy !== undefined ? { readLegacy: opts.legacy } : {}),
  });
  return { store, inner };
}

const sampleGroup: WatchGroup = {
  name: 'core',
  conditions: [sampleCondition],
  intervalSec: 20,
  pushIntervalSec: 300,
  enabled: true,
  createdAt: NOW_ISO,
};
const sampleTask: WatchTask = {
  idx: 1,
  market: 'a',
  code: '600519',
  name: '贵州茅台',
  groupName: 'core',
  conditions: [sampleCondition],
  intervalSec: 20,
  pushIntervalSec: 300,
  remaining: null,
  notifySlack: true,
  enabled: true,
  createdAt: NOW_ISO,
  lastTickAt: null,
  lastPushAt: null,
  lastSampleAt: null,
  hitCount: 0,
  lastHitPrice: null,
};
const sampleEntry: LedgerEntry = { date: '2026-05-15', pnlAmount: '123.45' };

describe('UserBlobStore — read', () => {
  it('returns EMPTY_USER_BLOB when no row exists and no legacy data', async () => {
    const { store } = makeStore();
    const blob = await store.read(USER);
    expect(blob).toEqual(EMPTY_USER_BLOB);
  });

  it('round-trips a written blob', async () => {
    const { store } = makeStore();
    await store.update(USER, (current) => ({
      ...current,
      ledger: { entries: [sampleEntry] },
    }));
    const blob = await store.read(USER);
    expect(blob.ledger.entries).toEqual([sampleEntry]);
    expect(blob.schemaVersion).toBe(USER_BLOB_SCHEMA_VERSION);
  });

  it('falls back to empty when payload_json is corrupted', async () => {
    const { store, inner } = makeStore();
    await inner.upsert(USER, { id: 'singleton', payload_json: 'not json' });
    const blob = await store.read(USER);
    expect(blob).toEqual(EMPTY_USER_BLOB);
  });

  it('falls back to empty when payload_json carries an unknown schemaVersion', async () => {
    const { store, inner } = makeStore();
    await inner.upsert(USER, {
      id: 'singleton',
      payload_json: JSON.stringify({ schemaVersion: 999, watch: {}, ledger: {}, sysCfg: {} }),
    });
    const blob = await store.read(USER);
    expect(blob).toEqual(EMPTY_USER_BLOB);
  });

  it('round-trips a v1 blob even when nested values would fail strict re-validation (boundary owns)', async () => {
    const { store, inner } = makeStore();
    // intervalSec: 1 violates WatchTaskSchema's min(5) — but a stored
    // blob that came in with that value before tightening must survive
    // a read.
    const looseTask = {
      idx: 1,
      market: 'a',
      code: '600000',
      name: '浦发',
      groupName: 'g1',
      conditions: [{ kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '5' }],
      intervalSec: 1,
      pushIntervalSec: 60,
      remaining: null,
      notifySlack: false,
      enabled: true,
      createdAt: '2026-05-01T00:00:00.000Z',
      lastTickAt: null,
      lastPushAt: null,
      lastSampleAt: null,
      hitCount: 0,
      lastHitPrice: null,
    };
    const stored = {
      schemaVersion: USER_BLOB_SCHEMA_VERSION,
      watch: { groups: [], tasks: { version: 2, nextIdx: 2, tasks: [looseTask] } },
      ledger: { entries: [] },
      sysCfg: DEFAULT_SYS_CFG,
    };
    await inner.upsert(USER, { id: 'singleton', payload_json: JSON.stringify(stored) });
    const blob = await store.read(USER);
    expect(blob.watch.tasks.tasks).toHaveLength(1);
    expect(blob.watch.tasks.tasks[0]?.intervalSec).toBe(1);
  });
});

describe('UserBlobStore — update', () => {
  it('mutates only the slice the patch touches', async () => {
    const { store } = makeStore();
    await store.update(USER, (b) => ({ ...b, ledger: { entries: [sampleEntry] } }));
    const after = await store.update(USER, (b) => ({
      ...b,
      watch: { ...b.watch, groups: [sampleGroup] },
    }));
    expect(after.ledger.entries).toEqual([sampleEntry]);
    expect(after.watch.groups).toEqual([sampleGroup]);
    expect(after.sysCfg).toEqual(DEFAULT_SYS_CFG);
  });

  it('writes through even when the patch produces a schema-invalid blob (boundary owns validation)', async () => {
    const warnings: string[] = [];
    const inner = new InMemoryUserScopedRecordStore<UserBlobRow>(USER_BLOB_TABLE_SPEC);
    const store = new UserBlobStore({
      dataRoot: '/unused',
      inner,
      readLegacy: async () => ({}),
      logger: { warn: (m) => warnings.push(m) },
    });
    await store.update(USER, () => ({
      schemaVersion: USER_BLOB_SCHEMA_VERSION,
      watch: { groups: [{ name: '' }], tasks: EMPTY_WATCH_TASK_FILE } as never,
      ledger: { entries: [] },
      sysCfg: DEFAULT_SYS_CFG,
    }));
    expect(warnings.find((w) => w.includes('user_blob_write_loose'))).toBeDefined();
    const row = await inner.get(USER, 'singleton');
    expect(row).not.toBeNull();
  });

  it('serializes concurrent updates per user — no lost writes', async () => {
    const { store } = makeStore();
    await store.update(USER, (b) => ({ ...b, ledger: { entries: [] } }));
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.update(USER, (b) => ({
        ...b,
        ledger: {
          entries: [
            ...b.ledger.entries,
            { date: `2026-05-${String(i + 1).padStart(2, '0')}`, pnlAmount: String(i) },
          ],
        },
      })),
    );
    await Promise.all(writes);
    const blob = await store.read(USER);
    expect(blob.ledger.entries).toHaveLength(10);
    const dates = blob.ledger.entries.map((e) => e.date);
    expect(new Set(dates).size).toBe(10);
  });

  it('stores tasks file with monotonic nextIdx preserved', async () => {
    const { store } = makeStore();
    await store.update(USER, (b) => ({
      ...b,
      watch: {
        groups: [sampleGroup],
        tasks: { version: 2, nextIdx: 7, tasks: [sampleTask] },
      },
    }));
    const blob = await store.read(USER);
    expect(blob.watch.tasks.nextIdx).toBe(7);
    expect(blob.watch.tasks.tasks).toHaveLength(1);
  });
});

describe('UserBlobStore — lazy migration from legacy', () => {
  it('seeds from legacy slices on first read', async () => {
    let calls = 0;
    const { store } = makeStore({
      legacy: async () => {
        calls += 1;
        return {
          watch: { groups: [sampleGroup], tasks: EMPTY_WATCH_TASK_FILE },
          ledger: { entries: [sampleEntry] },
        };
      },
    });
    const blob = await store.read(USER);
    expect(blob.watch.groups).toEqual([sampleGroup]);
    expect(blob.ledger.entries).toEqual([sampleEntry]);
    expect(blob.sysCfg).toEqual(DEFAULT_SYS_CFG);
    expect(calls).toBe(1);
  });

  it('does not invoke the legacy reader after the user is migrated', async () => {
    let calls = 0;
    const { store } = makeStore({
      legacy: async () => {
        calls += 1;
        return { ledger: { entries: [sampleEntry] } };
      },
    });
    await store.read(USER);
    await store.read(USER);
    await store.update(USER, (b) => b);
    expect(calls).toBe(1);
  });

  it('does not invoke the legacy reader when user.parquet already exists', async () => {
    let calls = 0;
    const { store, inner } = makeStore({
      legacy: async () => {
        calls += 1;
        return { ledger: { entries: [sampleEntry] } };
      },
    });
    await inner.upsert(USER, {
      id: 'singleton',
      payload_json: JSON.stringify(EMPTY_USER_BLOB),
    });
    await store.read(USER);
    expect(calls).toBe(0);
  });

  it('treats an empty legacy result as a no-op (still reports empty blob)', async () => {
    const { store } = makeStore({ legacy: async () => ({}) });
    const blob = await store.read(USER);
    expect(blob).toEqual(EMPTY_USER_BLOB);
  });

  it('isolates users — migration state is per-userId', async () => {
    let calls = 0;
    const { store } = makeStore({
      legacy: async () => {
        calls += 1;
        return { ledger: { entries: [sampleEntry] } };
      },
    });
    await store.read('a');
    await store.read('b');
    expect(calls).toBe(2);
  });
});

describe('slice helpers', () => {
  it('parseWatchSlice rejects malformed input', () => {
    expect(parseWatchSlice(null)).toBeUndefined();
    expect(parseWatchSlice({ groups: [] })).toBeUndefined();
    expect(parseWatchSlice({ groups: [], tasks: EMPTY_WATCH_TASK_FILE })).toEqual({
      groups: [],
      tasks: EMPTY_WATCH_TASK_FILE,
    });
  });

  it('parseLedgerSlice rejects malformed input', () => {
    expect(parseLedgerSlice(null)).toBeUndefined();
    expect(parseLedgerSlice({ entries: 'no' })).toBeUndefined();
    expect(parseLedgerSlice({ entries: [sampleEntry] })).toEqual({ entries: [sampleEntry] });
  });

  it('parseWatchGroupsArray accepts a bare array of groups', () => {
    expect(parseWatchGroupsArray(null)).toBeUndefined();
    expect(parseWatchGroupsArray([sampleGroup])).toEqual([sampleGroup]);
  });

  it('buildWatchSlice fills defaults for missing parts', () => {
    expect(buildWatchSlice(undefined, undefined)).toEqual({
      groups: [],
      tasks: EMPTY_WATCH_TASK_FILE,
    });
    expect(buildWatchSlice([sampleGroup], undefined)).toEqual({
      groups: [sampleGroup],
      tasks: EMPTY_WATCH_TASK_FILE,
    });
  });
});
