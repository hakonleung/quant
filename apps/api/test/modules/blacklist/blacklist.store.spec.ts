import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { EMPTY_BLACKLIST, type BlacklistSnapshot } from '@quant/shared';

import { BlacklistStore } from '../../../src/modules/blacklist/blacklist.store.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'blacklist-store-'));
}

const fixture: BlacklistSnapshot = {
  codes: ['000001', '600519'],
  asof: '2026-05-04',
  universeSize: 5500,
  computedAt: '2026-05-04T07:15:00.000Z',
};

describe('BlacklistStore', () => {
  it('loads an empty snapshot when blacklist.json is missing', async () => {
    const dir = await tmpDir();
    const store = new BlacklistStore(dir);

    await store.load();

    expect(store.snapshot()).toEqual(EMPTY_BLACKLIST);
    expect(store.has('000001')).toBe(false);
  });

  it('loads + parses a valid snapshot from disk', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'blacklist.json'), JSON.stringify(fixture));
    const store = new BlacklistStore(dir);

    await store.load();

    expect(store.snapshot()).toEqual(fixture);
    expect(store.has('000001')).toBe(true);
    expect(store.has('600519')).toBe(true);
    expect(store.has('999999')).toBe(false);
  });

  it('falls back to EMPTY_BLACKLIST when the on-disk file fails zod validation', async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, 'blacklist.json'),
      JSON.stringify({ codes: ['000001'], asof: 'not-a-date', universeSize: -1 }),
    );
    const store = new BlacklistStore(dir);

    await store.load();

    expect(store.snapshot()).toEqual(EMPTY_BLACKLIST);
    expect(store.has('000001')).toBe(false);
  });

  it('replace writes atomically and updates the in-memory codeSet', async () => {
    const dir = await tmpDir();
    const store = new BlacklistStore(dir);
    await store.load();

    const out = await store.replace(fixture);

    expect(out).toEqual(fixture);
    expect(store.snapshot()).toEqual(fixture);
    expect(store.has('000001')).toBe(true);
    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, 'blacklist.json'), 'utf8'),
    ) as unknown;
    expect(onDisk).toEqual(fixture);
  });

  it('load is idempotent — second call is a no-op', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'blacklist.json'), JSON.stringify(fixture));
    const store = new BlacklistStore(dir);

    await store.load();
    // Mutate the file underneath; load() must not re-read.
    await fs.writeFile(
      path.join(dir, 'blacklist.json'),
      JSON.stringify({ ...fixture, codes: ['111111'] }),
    );
    await store.load();

    expect(store.snapshot().codes).toEqual(['000001', '600519']);
  });

  it('snapshot is a stable reference between load and replace', async () => {
    const dir = await tmpDir();
    const store = new BlacklistStore(dir);
    await store.load();

    const a = store.snapshot();
    const b = store.snapshot();
    expect(a).toBe(b);
  });
});
