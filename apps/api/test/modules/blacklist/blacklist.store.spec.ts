import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { EMPTY_BLACKLIST, type BlacklistSnapshot } from '@quant/shared';

import {
  BlacklistStore,
  BLACKLIST_TABLE_SPEC,
  type BlacklistRow,
} from '../../../src/modules/blacklist/blacklist.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'blacklist-store-'));
}

function makeStore(dir: string): {
  store: BlacklistStore;
  record: InMemoryRecordStore<BlacklistRow>;
} {
  const record = new InMemoryRecordStore<BlacklistRow>(BLACKLIST_TABLE_SPEC);
  const store = new BlacklistStore(record, dir);
  return { store, record };
}

const fixture: BlacklistSnapshot = {
  codes: ['000001', '600519'],
  asof: '2026-05-04',
  universeSize: 5500,
  computedAt: '2026-05-04T07:15:00.000Z',
};

describe('BlacklistStore', () => {
  it('loads an empty snapshot when neither record store nor legacy file exists', async () => {
    const dir = await tmpDir();
    const { store } = makeStore(dir);

    await store.load();

    expect(store.snapshot()).toEqual(EMPTY_BLACKLIST);
    expect(store.has('000001')).toBe(false);
  });

  it('loads + parses a valid snapshot from the record store', async () => {
    const dir = await tmpDir();
    const { store, record } = makeStore(dir);
    await record.upsert({
      id: 'singleton',
      codes_json: JSON.stringify(fixture.codes),
      asof: fixture.asof,
      universeSize: fixture.universeSize,
      computedAt: fixture.computedAt,
    });

    await store.load();

    expect(store.snapshot()).toEqual(fixture);
    expect(store.has('000001')).toBe(true);
    expect(store.has('600519')).toBe(true);
    expect(store.has('999999')).toBe(false);
  });

  it('migrates a legacy blacklist.json into the record store and renames it to .bak', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'blacklist.json'), JSON.stringify(fixture));
    const { store, record } = makeStore(dir);

    await store.load();

    expect(store.snapshot()).toEqual(fixture);
    await expect(record.count()).resolves.toBe(1);
    await expect(fs.access(path.join(dir, 'blacklist.json'))).rejects.toBeDefined();
    await expect(fs.access(path.join(dir, 'blacklist.json.bak'))).resolves.toBeUndefined();
  });

  it('ignores a legacy blacklist.json that fails zod validation', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, 'blacklist.json'),
      JSON.stringify({ codes: ['000001'], asof: 'not-a-date', universeSize: -1 }),
    );
    const { store } = makeStore(dir);

    await store.load();

    expect(store.snapshot()).toEqual(EMPTY_BLACKLIST);
    expect(store.has('000001')).toBe(false);
  });

  it('replace writes to the record store and updates the in-memory codeSet', async () => {
    const dir = await tmpDir();
    const { store, record } = makeStore(dir);
    await store.load();

    const out = await store.replace(fixture);

    expect(out).toEqual(fixture);
    expect(store.snapshot()).toEqual(fixture);
    expect(store.has('000001')).toBe(true);
    const row = await record.get('singleton');
    expect(row).not.toBeNull();
    expect(row?.codes_json).toEqual(JSON.stringify(fixture.codes));
    expect(row?.asof).toEqual(fixture.asof);
  });

  it('load is idempotent — second call is a no-op', async () => {
    const dir = await tmpDir();
    const { store, record } = makeStore(dir);
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

    expect(store.snapshot().codes).toEqual(['000001', '600519']);
  });

  it('snapshot is a stable reference between load and replace', async () => {
    const dir = await tmpDir();
    const { store } = makeStore(dir);
    await store.load();

    const a = store.snapshot();
    const b = store.snapshot();
    expect(a).toBe(b);
  });

  it('replace surfaces malformed codes_json on subsequent load as empty codes', async () => {
    const dir = await tmpDir();
    const { store, record } = makeStore(dir);
    await record.upsert({
      id: 'singleton',
      codes_json: 'not-json',
      asof: fixture.asof,
      universeSize: fixture.universeSize,
      computedAt: fixture.computedAt,
    });

    await store.load();

    expect(store.snapshot().codes).toEqual([]);
    expect(store.snapshot().asof).toEqual(fixture.asof);
  });
});
