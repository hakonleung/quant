import { EMPTY_BLACKLIST, PERMANENT_BLACKLIST, type BlacklistSnapshot } from '@quant/shared';

/** Sorted union of `extra ∪ PERMANENT_BLACKLIST`. */
function mergedCodes(extra: readonly string[]): readonly string[] {
  return [...new Set<string>([...extra, ...PERMANENT_BLACKLIST])].sort();
}

import {
  BlacklistStore,
  BLACKLIST_TABLE_SPEC,
  type BlacklistRow,
} from '../../../src/modules/blacklist/blacklist.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

function makeStore(): {
  store: BlacklistStore;
  record: InMemoryRecordStore<BlacklistRow>;
} {
  const record = new InMemoryRecordStore<BlacklistRow>(BLACKLIST_TABLE_SPEC);
  const store = new BlacklistStore(record);
  return { store, record };
}

const fixture: BlacklistSnapshot = {
  codes: ['000001', '600519'],
  asof: '2026-05-04',
  universeSize: 5500,
  computedAt: '2026-05-04T07:15:00.000Z',
};

describe('BlacklistStore', () => {
  it('loads an empty snapshot when the record store is empty', async () => {
    const { store } = makeStore();

    await store.load();

    expect(store.snapshot()).toEqual({
      ...EMPTY_BLACKLIST,
      codes: mergedCodes([]),
    });
    expect(store.has('000001')).toBe(false);
    for (const c of PERMANENT_BLACKLIST) expect(store.has(c)).toBe(true);
  });

  it('loads + parses a valid snapshot from the record store', async () => {
    const { store, record } = makeStore();
    await record.upsert({
      id: 'singleton',
      codes_json: JSON.stringify(fixture.codes),
      asof: fixture.asof,
      universeSize: fixture.universeSize,
      computedAt: fixture.computedAt,
    });

    await store.load();

    expect(store.snapshot()).toEqual({ ...fixture, codes: mergedCodes(fixture.codes) });
    expect(store.has('000001')).toBe(true);
    expect(store.has('600519')).toBe(true);
    expect(store.has('999999')).toBe(false);
  });

  it('replace writes to the record store and updates the in-memory codeSet', async () => {
    const { store, record } = makeStore();
    await store.load();

    const out = await store.replace(fixture);

    const expected: BlacklistSnapshot = { ...fixture, codes: mergedCodes(fixture.codes) };
    expect(out).toEqual(expected);
    expect(store.snapshot()).toEqual(expected);
    expect(store.has('000001')).toBe(true);
    const row = await record.get('singleton');
    expect(row).not.toBeNull();
    // Persistence keeps the cron-computed list verbatim; permanent codes
    // are merged in memory only.
    expect(row?.codes_json).toEqual(JSON.stringify(fixture.codes));
    expect(row?.asof).toEqual(fixture.asof);
  });

  it('load is idempotent — second call is a no-op', async () => {
    const { store, record } = makeStore();
    await record.upsert({
      id: 'singleton',
      codes_json: JSON.stringify(fixture.codes),
      asof: fixture.asof,
      universeSize: fixture.universeSize,
      computedAt: fixture.computedAt,
    });

    await store.load();
    // Mutate the underlying store; load() must not re-read.
    await record.upsert({
      id: 'singleton',
      codes_json: JSON.stringify(['111111']),
      asof: fixture.asof,
      universeSize: fixture.universeSize,
      computedAt: fixture.computedAt,
    });
    await store.load();

    expect(store.snapshot().codes).toEqual(mergedCodes(['000001', '600519']));
  });

  it('snapshot is a stable reference between load and replace', async () => {
    const { store } = makeStore();
    await store.load();

    const a = store.snapshot();
    const b = store.snapshot();
    expect(a).toBe(b);
  });

  it('replace surfaces malformed codes_json on subsequent load as empty codes', async () => {
    const { store, record } = makeStore();
    await record.upsert({
      id: 'singleton',
      codes_json: 'not-json',
      asof: fixture.asof,
      universeSize: fixture.universeSize,
      computedAt: fixture.computedAt,
    });

    await store.load();

    expect(store.snapshot().codes).toEqual(mergedCodes([]));
    expect(store.snapshot().asof).toEqual(fixture.asof);
  });
});
