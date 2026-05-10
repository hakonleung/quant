import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LedgerEntry } from '@quant/shared';

import type { AuthConfigShape } from '../../../src/modules/auth/config/auth.config.js';
import { LedgerStore } from '../../../src/modules/ledger/ledger.store.js';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ledger-store-'));
}

function cfg(dataRoot: string): AuthConfigShape {
  return {
    mode: 'disabled',
    nextauthSecret: null,
    dataRoot,
    adminUserId: 'admin',
    adminUserIds: new Set<string>(),
  };
}

const USER = 'admin';
const fixture: readonly LedgerEntry[] = [
  { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
  { date: '2026-05-02', pnlAmount: '500' },
];

describe('LedgerStore', () => {
  it('returns an empty snapshot when entries.json is missing', async () => {
    const root = await tmpRoot();
    const store = new LedgerStore(cfg(root));
    expect(await store.list(USER)).toEqual([]);
  });

  it('loads + validates an existing snapshot', async () => {
    const root = await tmpRoot();
    const userDir = path.join(root, 'users', USER, '_ledger');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, 'entries.json'), JSON.stringify({ entries: fixture }));
    const store = new LedgerStore(cfg(root));
    expect(await store.list(USER)).toEqual(fixture);
  });

  it('falls back to empty when entries.json fails validation', async () => {
    const root = await tmpRoot();
    const userDir = path.join(root, 'users', USER, '_ledger');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, 'entries.json'), JSON.stringify({ entries: 'oops' }));
    const store = new LedgerStore(cfg(root));
    expect(await store.list(USER)).toEqual([]);
  });

  it('replace persists atomically and updates in-memory state', async () => {
    const root = await tmpRoot();
    const store = new LedgerStore(cfg(root));
    await store.replace(USER, fixture);
    await store.flushNow(USER);
    expect(await store.list(USER)).toEqual(fixture);
    const target = path.join(root, 'users', USER, '_ledger', 'entries.json');
    const raw = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
    expect(raw).toEqual({ entries: fixture });
  });

  it('replace rejects when earliest entry has no closingPosition', async () => {
    const root = await tmpRoot();
    const store = new LedgerStore(cfg(root));
    const bad: LedgerEntry[] = [{ date: '2026-05-01', pnlAmount: '0' }];
    await expect(store.replace(USER, bad)).rejects.toMatchObject({
      code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
    });
  });

  it('replace rejects on duplicate dates', async () => {
    const root = await tmpRoot();
    const store = new LedgerStore(cfg(root));
    const bad: LedgerEntry[] = [
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100' },
      { date: '2026-05-01', pnlAmount: '5' },
    ];
    await expect(store.replace(USER, bad)).rejects.toMatchObject({
      code: 'LEDGER_DUPLICATE_DATE',
    });
  });

  it('isolates per-user state', async () => {
    const root = await tmpRoot();
    const store = new LedgerStore(cfg(root));
    await store.replace('alice', fixture);
    expect(await store.list('bob')).toEqual([]);
    expect(await store.list('alice')).toEqual(fixture);
  });
});
