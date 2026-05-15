import type { LedgerEntry } from '@quant/shared';

import { LedgerStore } from '../../../src/modules/ledger/ledger.store.js';
import { makeUserBlobStore } from '../../fakes/in-memory-user-blob.store.js';

function makeStore(): { store: LedgerStore; blob: ReturnType<typeof makeUserBlobStore> } {
  const blob = makeUserBlobStore();
  return { store: new LedgerStore(blob.store), blob };
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

  it('round-trips a fixture through the user blob', async () => {
    const { store } = makeStore();
    await store.replace(USER, fixture);
    expect(await store.list(USER)).toEqual(fixture);
  });

  it('replace persists entries inside the user blob', async () => {
    const { store, blob } = makeStore();
    await store.replace(USER, fixture);
    const onDisk = await blob.store.read(USER);
    expect(onDisk.ledger.entries).toEqual(fixture);
  });

  it('replace wipes prior entries that drop out of the new list', async () => {
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

  it('list returns entries sorted ascending by date', async () => {
    const { store } = makeStore();
    await store.replace(USER, [
      { date: '2026-05-02', pnlAmount: '500' },
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const out = await store.list(USER);
    expect(out.map((e) => e.date)).toEqual(['2026-05-01', '2026-05-02']);
  });
});
