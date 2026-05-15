import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Sector } from '@quant/shared';

import {
  SECTORS_TABLE_SPEC,
  SectorsStore,
  type SectorRow,
} from '../../../src/modules/sectors/sectors.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sectors-store-'));
}

function makeStore(dir = '/unused'): {
  store: SectorsStore;
  record: InMemoryRecordStore<SectorRow>;
} {
  const record = new InMemoryRecordStore<SectorRow>(SECTORS_TABLE_SPEC);
  const store = new SectorsStore(record, dir);
  return { store, record };
}

async function seedRecord(
  record: InMemoryRecordStore<SectorRow>,
  sectors: readonly Sector[],
): Promise<void> {
  for (const s of sectors) {
    await record.upsert({ id: s.id, payload_json: JSON.stringify(s) });
  }
}

const userBase = (id: string, overrides: Partial<Sector> = {}): Sector => ({
  id,
  name: `name-${id}`,
  kind: 'user',
  count: 0,
  meta: '',
  chgPct: null,
  codes: [],
  createdBy: 'admin',
  published: false,
  ...overrides,
});

describe('SectorsStore migration & id allocation', () => {
  it('reseqs non-`s{n}` ids to s1.. on load + rewrites record store', async () => {
    const { store, record } = makeStore();
    await seedRecord(record, [
      { ...userBase('legacy-foo'), id: 'legacy-foo' },
      { ...userBase('s5'), id: 's5' },
      { ...userBase('test2-tr43r6'), id: 'test2-tr43r6' },
    ]);

    await store.load();

    const ids = store.list().map((s) => s.id);
    expect(ids).toEqual(['s1', 's5', 's2']);

    const rows = await record.list({ orderBy: [{ column: 'id', dir: 'asc' }] });
    expect(rows.map((r) => r.id).sort()).toEqual(['s1', 's2', 's5']);
  });

  it('keeps record store untouched when every id is already `s{n}`', async () => {
    const { store, record } = makeStore();
    await seedRecord(record, [userBase('s1'), userBase('s2')]);
    const baselineRows = await record.list();
    const baseline = baselineRows.map((r) => r.payload_json);

    await store.load();

    const after = await record.list();
    expect(after.map((r) => r.payload_json)).toEqual(baseline);
    expect(store.list().map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('upsert with empty id allocates the next free `s{n}`', async () => {
    const { store, record } = makeStore();
    await seedRecord(record, [userBase('s3')]);
    await store.load();

    const out = await store.upsert(userBase('', { name: 'fresh' }));
    expect(out.id).toBe('s4');
    const next = await store.upsert(userBase('', { name: 'fresh2' }));
    expect(next.id).toBe('s5');
  });

  it('upsert with existing `s{n}` updates in place', async () => {
    const { store, record } = makeStore();
    await seedRecord(record, [userBase('s1', { name: 'old' })]);
    await store.load();

    const out = await store.upsert(userBase('s1', { name: 'new' }));
    expect(out.id).toBe('s1');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.name).toBe('new');
  });

  it('replaceForUser allocates ids for new (empty-id) records', async () => {
    const { store, record } = makeStore();
    await seedRecord(record, [userBase('s1')]);
    await store.load();

    const next = await store.replaceForUser('admin', [
      userBase('s1', { name: 'kept' }),
      userBase('', { name: 'new1' }),
      userBase('', { name: 'new2' }),
    ]);
    expect(next.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('concurrent upserts each get a distinct `s{n}` under the lock', async () => {
    const { store } = makeStore();
    await store.load();

    const results = await Promise.all([
      store.upsert(userBase('', { name: 'a' })),
      store.upsert(userBase('', { name: 'b' })),
      store.upsert(userBase('', { name: 'c' })),
    ]);
    const ids = results.map((s) => s.id).sort();
    expect(ids).toEqual(['s1', 's2', 's3']);
  });

  it('removeById deletes the row from the record store', async () => {
    const { store, record } = makeStore();
    await seedRecord(record, [userBase('s1'), userBase('s2')]);
    await store.load();

    await expect(store.removeById('s1')).resolves.toBe(true);
    expect(store.list().map((s) => s.id)).toEqual(['s2']);
    await expect(record.count()).resolves.toBe(1);
  });
});

describe('SectorsStore legacy filesystem migration', () => {
  it('imports legacy sectors.json into record store and renames to .bak', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'sectors', 'sectors.json');
    const legacy = [
      { ...userBase('legacy-foo'), id: 'legacy-foo' },
      { ...userBase('s2'), id: 's2' },
    ];
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(legacy));

    const { store, record } = makeStore(dir);
    await store.load();

    expect(store.list().map((s) => s.id).sort()).toEqual(['s1', 's2']);
    await expect(record.count()).resolves.toBe(2);
    await expect(fs.access(file)).rejects.toBeDefined();
    await expect(fs.access(`${file}.bak`)).resolves.toBeUndefined();
  });
});
