import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { UserScopedJsonStore } from '../../src/common/user-scoped-store.js';

const SnapshotSchema = z.object({ items: z.array(z.string()) }).strict();
type Snapshot = z.infer<typeof SnapshotSchema>;

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'user-store-'));
}

function build(root: string): UserScopedJsonStore<Snapshot> {
  return new UserScopedJsonStore<Snapshot>(root, {
    relativePath: (uid) => `users/${uid}/data.json`,
    schema: SnapshotSchema,
    fallback: () => ({ items: [] }),
    minFlushIntervalMs: 0,
  });
}

describe('UserScopedJsonStore', () => {
  it('returns the fallback when the file is missing', async () => {
    const store = build(await tmpRoot());
    expect(await store.snapshot('alice')).toEqual({ items: [] });
  });

  it('isolates state across users', async () => {
    const root = await tmpRoot();
    const store = build(root);
    await store.replace('alice', { items: ['a'] });
    await store.replace('bob', { items: ['b'] });
    expect(await store.snapshot('alice')).toEqual({ items: ['a'] });
    expect(await store.snapshot('bob')).toEqual({ items: ['b'] });
  });

  it('persists writes atomically (file readable after replace)', async () => {
    const root = await tmpRoot();
    const store = build(root);
    await store.replace('alice', { items: ['x', 'y'] });
    await store.flushNow('alice');
    const target = path.join(root, 'users', 'alice', 'data.json');
    const raw = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
    expect(raw).toEqual({ items: ['x', 'y'] });
  });

  it('survives unicode and colon-bearing userIds', async () => {
    const root = await tmpRoot();
    const store = build(root);
    const uid = 'feishu:ou_测试';
    await store.replace(uid, { items: ['ok'] });
    await store.flushNow(uid);
    expect(await store.snapshot(uid)).toEqual({ items: ['ok'] });
  });

  it('falls back when on-disk shape fails validation', async () => {
    const root = await tmpRoot();
    const userDir = path.join(root, 'users', 'alice');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, 'data.json'), JSON.stringify({ items: 'oops' }));
    const store = build(root);
    expect(await store.snapshot('alice')).toEqual({ items: [] });
  });

  it('mutate observes the prior value and writes the new one', async () => {
    const root = await tmpRoot();
    const store = build(root);
    await store.replace('alice', { items: ['a'] });
    const next = await store.mutate('alice', (cur) => ({ items: [...cur.items, 'b'] }));
    expect(next).toEqual({ items: ['a', 'b'] });
    expect(await store.snapshot('alice')).toEqual({ items: ['a', 'b'] });
  });
});
