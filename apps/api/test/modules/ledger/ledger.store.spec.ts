import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LedgerEntry } from '@quant/shared';

import { LedgerStore } from '../../../src/modules/ledger/ledger.store.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ledger-store-'));
}

const fixture: readonly LedgerEntry[] = [
  { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
  { date: '2026-05-02', pnlAmount: '500' },
];

describe('LedgerStore', () => {
  it('loads an empty snapshot when entries.json is missing', async () => {
    const dir = await tmpDir();
    const store = new LedgerStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('loads + validates an existing snapshot', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'entries.json'), JSON.stringify({ entries: fixture }));
    const store = new LedgerStore(dir);
    await store.load();
    expect(store.list()).toEqual(fixture);
  });

  it('falls back to empty when entries.json fails validation', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'entries.json'), JSON.stringify({ entries: 'oops' }));
    const store = new LedgerStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('replace persists atomically and updates in-memory state', async () => {
    const dir = await tmpDir();
    const store = new LedgerStore(dir);
    await store.load();
    await store.replace(fixture);
    await store.flushNow();
    expect(store.list()).toEqual(fixture);
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'entries.json'), 'utf8')) as unknown;
    expect(raw).toEqual({ entries: fixture });
  });

  it('replace rejects when earliest entry has no closingPosition', async () => {
    const dir = await tmpDir();
    const store = new LedgerStore(dir);
    await store.load();
    const bad: LedgerEntry[] = [{ date: '2026-05-01', pnlAmount: '0' }];
    await expect(store.replace(bad)).rejects.toMatchObject({
      code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
    });
  });

  it('replace rejects on duplicate dates', async () => {
    const dir = await tmpDir();
    const store = new LedgerStore(dir);
    await store.load();
    const bad: LedgerEntry[] = [
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100' },
      { date: '2026-05-01', pnlAmount: '5' },
    ];
    await expect(store.replace(bad)).rejects.toMatchObject({
      code: 'LEDGER_DUPLICATE_DATE',
    });
  });
});
