import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Sector } from '@quant/shared';

import { SectorsStore } from '../../../src/modules/sectors/sectors.store.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sectors-store-'));
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
  it('reseqs non-`s{n}` ids to s1.. and writes the migrated file back', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'sectors.json');
    const initial = [
      { ...userBase('legacy-foo'), id: 'legacy-foo' },
      { ...userBase('s5'), id: 's5' },
      { ...userBase('test2-tr43r6'), id: 'test2-tr43r6' },
    ];
    await fs.writeFile(file, JSON.stringify(initial));

    const store = new SectorsStore(dir);
    await store.load();

    const ids = store.list().map((s) => s.id);
    expect(ids).toEqual(['s1', 's5', 's2']);

    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as readonly Sector[];
    expect(onDisk.map((s) => s.id)).toEqual(['s1', 's5', 's2']);
  });

  it('skips writing back when every id is already `s{n}`', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'sectors.json');
    const initial = [userBase('s1'), userBase('s2')];
    await fs.writeFile(file, JSON.stringify(initial));
    const before = await fs.stat(file);

    const store = new SectorsStore(dir);
    await store.load();

    const after = await fs.stat(file);
    // mtime is preserved when no migration happened (no atomic rename).
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(store.list().map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('upsert with empty id allocates the next free `s{n}`', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'sectors.json');
    await fs.writeFile(file, JSON.stringify([userBase('s3')]));

    const store = new SectorsStore(dir);
    await store.load();

    const newSec = userBase('', { name: 'fresh' });
    const out = await store.upsert(newSec);
    expect(out.id).toBe('s4');
    const next = await store.upsert(userBase('', { name: 'fresh2' }));
    expect(next.id).toBe('s5');
  });

  it('upsert with existing `s{n}` updates in place', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'sectors.json');
    await fs.writeFile(file, JSON.stringify([userBase('s1', { name: 'old' })]));

    const store = new SectorsStore(dir);
    await store.load();

    const out = await store.upsert(userBase('s1', { name: 'new' }));
    expect(out.id).toBe('s1');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.name).toBe('new');
  });

  it('replaceForUser allocates ids for new (empty-id) records', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'sectors.json');
    await fs.writeFile(file, JSON.stringify([userBase('s1')]));

    const store = new SectorsStore(dir);
    await store.load();

    const next = await store.replaceForUser('admin', [
      userBase('s1', { name: 'kept' }),
      userBase('', { name: 'new1' }),
      userBase('', { name: 'new2' }),
    ]);
    const ids = next.map((s) => s.id);
    expect(ids).toEqual(['s1', 's2', 's3']);
  });

  it('concurrent upserts each get a distinct `s{n}` under the lock', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'sectors.json');
    await fs.writeFile(file, JSON.stringify([]));

    const store = new SectorsStore(dir);
    await store.load();

    const results = await Promise.all([
      store.upsert(userBase('', { name: 'a' })),
      store.upsert(userBase('', { name: 'b' })),
      store.upsert(userBase('', { name: 'c' })),
    ]);
    const ids = results.map((s) => s.id).sort();
    expect(ids).toEqual(['s1', 's2', 's3']);
  });
});
