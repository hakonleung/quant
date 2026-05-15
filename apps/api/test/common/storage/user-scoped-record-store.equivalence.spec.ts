import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from '../../../src/common/storage/adapters/filesystem-user-scoped-record.store.js';
import type { RecordTableSpec } from '../../../src/common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../../src/common/storage/ports/user-scoped-record-store.port.js';
import { InMemoryUserScopedRecordStore } from '../../fakes/in-memory-user-scoped-record.store.js';

interface Note {
  id: string;
  body: string;
  weight: number;
}

const spec: RecordTableSpec<Note> = {
  table: 'notes',
  schema: z.object({ id: z.string(), body: z.string(), weight: z.number() }),
  pk: (n) => n.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'body', type: 'VARCHAR', nullable: false },
    { name: 'weight', type: 'INTEGER', nullable: false },
  ],
};

interface Backend {
  readonly label: string;
  build: () => Promise<UserScopedRecordStore<Note>>;
  cleanup: () => Promise<void>;
}

function inMemoryBackend(): Backend {
  return {
    label: 'in-memory',
    async build() {
      return new InMemoryUserScopedRecordStore<Note>(spec);
    },
    async cleanup() {
      // nothing
    },
  };
}

function filesystemBackend(): Backend {
  let dir: string | null = null;
  return {
    label: 'filesystem',
    async build() {
      dir = await mkdtemp(join(tmpdir(), 'user-scoped-test-'));
      return new FileSystemUserScopedRecordStore<Note>({
        dataRoot: dir,
        spec,
      });
    },
    async cleanup() {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
      dir = null;
    },
  };
}

const backends: Backend[] = [inMemoryBackend(), filesystemBackend()];

describe.each(backends)('UserScopedRecordStore [$label]', (backend) => {
  let store: UserScopedRecordStore<Note>;

  beforeEach(async () => {
    store = await backend.build();
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  it('isolates rows by userId', async () => {
    await store.upsert('alice', { id: 'n1', body: 'a-note', weight: 1 });
    await store.upsert('bob', { id: 'n1', body: 'b-note', weight: 2 });
    await expect(store.get('alice', 'n1')).resolves.toEqual({
      id: 'n1',
      body: 'a-note',
      weight: 1,
    });
    await expect(store.get('bob', 'n1')).resolves.toEqual({
      id: 'n1',
      body: 'b-note',
      weight: 2,
    });
  });

  it('list returns only the targeted user rows', async () => {
    await store.upsertMany('alice', [
      { id: 'n1', body: 'a1', weight: 1 },
      { id: 'n2', body: 'a2', weight: 2 },
    ]);
    await store.upsert('bob', { id: 'n1', body: 'b1', weight: 9 });
    const aliceRows = await store.list('alice');
    expect(aliceRows.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    const bobRows = await store.list('bob');
    expect(bobRows.map((n) => n.id)).toEqual(['n1']);
  });

  it('delete removes a user-specific row', async () => {
    await store.upsert('alice', { id: 'n1', body: 'a', weight: 1 });
    await store.upsert('bob', { id: 'n1', body: 'b', weight: 1 });
    await expect(store.delete('alice', 'n1')).resolves.toBe(true);
    await expect(store.get('alice', 'n1')).resolves.toBeNull();
    await expect(store.get('bob', 'n1')).resolves.not.toBeNull();
  });

  it('purge wipes a single user but not others', async () => {
    await store.upsertMany('alice', [
      { id: 'n1', body: 'a', weight: 1 },
      { id: 'n2', body: 'a', weight: 2 },
    ]);
    await store.upsert('bob', { id: 'n1', body: 'b', weight: 1 });
    await store.purge('alice');
    await expect(store.count('alice')).resolves.toBe(0);
    await expect(store.count('bob')).resolves.toBe(1);
  });

  it('count respects filter', async () => {
    await store.upsertMany('alice', [
      { id: 'n1', body: 'a', weight: 1 },
      { id: 'n2', body: 'a', weight: 2 },
      { id: 'n3', body: 'a', weight: 1 },
    ]);
    await expect(store.count('alice', { where: { weight: 1 } })).resolves.toBe(2);
  });
});

describe('FileSystemUserScopedRecordStore extras', () => {
  it('persists user rows under data/users/{userId}/{table}.parquet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-user-store-'));
    try {
      const store = new FileSystemUserScopedRecordStore<Note>({
        dataRoot: dir,
        spec,
      });
      await store.upsert('alice', { id: 'n1', body: 'hello', weight: 1 });
      await store.flush('alice');

      const parquetPath = join(dir, 'users', 'alice', 'notes.parquet');
      await expect(stat(parquetPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives flush + reopen round-trip per user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-user-store-'));
    try {
      const a = new FileSystemUserScopedRecordStore<Note>({ dataRoot: dir, spec });
      await a.upsert('alice', { id: 'n1', body: 'one', weight: 1 });
      await a.upsert('bob', { id: 'n1', body: 'two', weight: 2 });
      await a.flush();

      const b = new FileSystemUserScopedRecordStore<Note>({ dataRoot: dir, spec });
      const aliceRows = await b.list('alice');
      const bobRows = await b.list('bob');
      expect(aliceRows.map((n) => n.body)).toEqual(['one']);
      expect(bobRows.map((n) => n.body)).toEqual(['two']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('LRU evicts the least-recently-touched user when over capacity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-user-store-'));
    try {
      let now = 1_000_000;
      const store = new FileSystemUserScopedRecordStore<Note>({
        dataRoot: dir,
        spec,
        maxActiveUsers: 2,
      }).withClock(() => now);

      await store.upsert('alice', { id: 'n1', body: 'a', weight: 1 });
      now += 1_000;
      await store.upsert('bob', { id: 'n1', body: 'b', weight: 1 });
      now += 1_000;
      await store.upsert('carol', { id: 'n1', body: 'c', weight: 1 });
      now += 1_000;

      // alice was the LRU candidate; she should have been evicted by now.
      // Re-reading her data forces a reload from parquet — exercise that.
      const aliceRows = await store.list('alice');
      expect(aliceRows.map((n) => n.body)).toEqual(['a']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
