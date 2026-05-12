import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LedgerEntry } from '@quant/shared';

import type { AuthConfigShape } from '../../../src/modules/auth/config/auth.config.js';
import {
  LedgerStore,
  buildLedgerUserScopedStore,
  type LedgerRow,
  LEDGER_TABLE_SPEC,
} from '../../../src/modules/ledger/ledger.store.js';
import { InMemoryUserScopedRecordStore } from '../../fakes/in-memory-user-scoped-record.store.js';

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

function makeStore(): {
  store: LedgerStore;
  inner: InMemoryUserScopedRecordStore<LedgerRow>;
} {
  const inner = new InMemoryUserScopedRecordStore<LedgerRow>(LEDGER_TABLE_SPEC);
  const store = new LedgerStore(inner, cfg('/unused'));
  return { store, inner };
}

const USER = 'admin';
const fixture: readonly LedgerEntry[] = [
  { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
  { date: '2026-05-02', pnlAmount: '500' },
];

describe('LedgerStore', () => {
  it('returns an empty snapshot when no rows exist', async () => {
    const { store } = makeStore();
    expect(await store.list(USER)).toEqual([]);
  });

  it('round-trips a fixture through the record store', async () => {
    const { store } = makeStore();
    await store.replace(USER, fixture);
    expect(await store.list(USER)).toEqual(fixture);
  });

  it('replace persists rows in the record store', async () => {
    const { store, inner } = makeStore();
    await store.replace(USER, fixture);
    const rows = await inner.list(USER, { orderBy: [{ column: 'date', dir: 'asc' }] });
    expect(rows).toEqual([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500', closingPosition: null },
    ]);
  });

  it('replace wipes prior rows that drop out of the new list', async () => {
    const { store } = makeStore();
    await store.replace(USER, fixture);
    const slimmed: readonly LedgerEntry[] = [
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ];
    await store.replace(USER, slimmed);
    expect(await store.list(USER)).toEqual(slimmed);
  });

  it('replace rejects when earliest entry has no closingPosition', async () => {
    const { store } = makeStore();
    const bad: LedgerEntry[] = [{ date: '2026-05-01', pnlAmount: '0' }];
    await expect(store.replace(USER, bad)).rejects.toMatchObject({
      code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
    });
  });

  it('replace rejects on duplicate dates', async () => {
    const { store } = makeStore();
    const bad: LedgerEntry[] = [
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100' },
      { date: '2026-05-01', pnlAmount: '5' },
    ];
    await expect(store.replace(USER, bad)).rejects.toMatchObject({
      code: 'LEDGER_DUPLICATE_DATE',
    });
  });

  it('isolates per-user state', async () => {
    const { store } = makeStore();
    await store.replace('alice', fixture);
    expect(await store.list('bob')).toEqual([]);
    expect(await store.list('alice')).toEqual(fixture);
  });

  it('snapshot wraps list in { entries }', async () => {
    const { store } = makeStore();
    await store.replace(USER, fixture);
    expect(await store.snapshot(USER)).toEqual({ entries: fixture });
  });
});

describe('LedgerStore filesystem migration (self-healing)', () => {
  it('imports a legacy entries.json on first access and renames it .bak', async () => {
    const root = await tmpRoot();
    const userDir = path.join(root, 'users', USER, '_ledger');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(
      path.join(userDir, 'entries.json'),
      JSON.stringify({ entries: fixture }),
    );

    const inner = buildLedgerUserScopedStore(cfg(root), {
      warn: () => undefined,
      log: () => undefined,
    });
    const store = new LedgerStore(inner, cfg(root));

    expect(await store.list(USER)).toEqual(fixture);
    await expect(fs.access(path.join(userDir, 'entries.json'))).rejects.toBeDefined();
    await expect(fs.access(path.join(userDir, 'entries.json.bak'))).resolves.toBeUndefined();
    await expect(fs.stat(path.join(root, 'users', USER, 'ledger.parquet'))).resolves.toBeDefined();
  });
});
