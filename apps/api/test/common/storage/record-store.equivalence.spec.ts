/**
 * Equivalence spec: every behavior we promise must be implemented
 * identically by `InMemoryRecordStore` and `DuckDBParquetRecordStore`.
 * If the two diverge, this test fails and forces us to pick which one
 * is correct rather than letting the prod adapter drift from the fake.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import type {
  RecordStore,
  RecordTableSpec,
} from '../../../src/common/storage/ports/record-store.port.js';
import { DuckDBParquetRecordStore } from '../../../src/common/storage/adapters/duckdb-parquet-record.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

interface Widget {
  id: string;
  name: string;
  count: number;
  active: boolean;
}

const widgetSpec: RecordTableSpec<Widget> = {
  table: 'widgets',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    count: z.number(),
    active: z.boolean(),
  }),
  pk: (w) => w.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'name', type: 'VARCHAR' },
    { name: 'count', type: 'INTEGER' },
    { name: 'active', type: 'BOOLEAN' },
  ],
};

interface Backend {
  readonly label: string;
  build: () => Promise<RecordStore<Widget>>;
  cleanup: () => Promise<void>;
}

function inMemoryBackend(): Backend {
  let store: InMemoryRecordStore<Widget> | null = null;
  return {
    label: 'in-memory',
    async build() {
      store = new InMemoryRecordStore<Widget>(widgetSpec);
      return store;
    },
    async cleanup() {
      store = null;
    },
  };
}

function duckdbBackend(): Backend {
  let dir: string | null = null;
  return {
    label: 'duckdb-parquet',
    async build() {
      dir = await mkdtemp(join(tmpdir(), 'record-store-test-'));
      return new DuckDBParquetRecordStore<Widget>({
        dataRoot: dir,
        spec: widgetSpec,
        minFlushIntervalMs: 0,
      });
    },
    async cleanup() {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
      dir = null;
    },
  };
}

const backends: Backend[] = [inMemoryBackend(), duckdbBackend()];

describe.each(backends)('RecordStore [$label]', (backend) => {
  let store: RecordStore<Widget>;

  beforeEach(async () => {
    store = await backend.build();
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  it('returns null when key absent', async () => {
    await expect(store.get('missing')).resolves.toBeNull();
  });

  it('upserts then reads single row', async () => {
    await store.upsert({ id: 'w1', name: 'first', count: 5, active: true });
    const got = await store.get('w1');
    expect(got).toEqual({ id: 'w1', name: 'first', count: 5, active: true });
  });

  it('upsertMany commits batch', async () => {
    await store.upsertMany([
      { id: 'a', name: 'A', count: 1, active: true },
      { id: 'b', name: 'B', count: 2, active: false },
      { id: 'c', name: 'C', count: 3, active: true },
    ]);
    expect(await store.count()).toBe(3);
  });

  it('upsert replaces existing row by pk', async () => {
    await store.upsert({ id: 'k', name: 'first', count: 1, active: true });
    await store.upsert({ id: 'k', name: 'second', count: 2, active: false });
    const got = await store.get('k');
    expect(got).toEqual({ id: 'k', name: 'second', count: 2, active: false });
    expect(await store.count()).toBe(1);
  });

  it('getMany returns only matching rows', async () => {
    await store.upsertMany([
      { id: 'a', name: 'A', count: 1, active: true },
      { id: 'b', name: 'B', count: 2, active: true },
    ]);
    const got = await store.getMany(['a', 'missing', 'b']);
    expect(got).toHaveLength(2);
    expect(got.map((w) => w.id).sort()).toEqual(['a', 'b']);
  });

  it('list with where filter', async () => {
    await store.upsertMany([
      { id: 'a', name: 'A', count: 1, active: true },
      { id: 'b', name: 'B', count: 2, active: false },
      { id: 'c', name: 'C', count: 3, active: true },
    ]);
    const got = await store.list({ where: { active: true } });
    expect(got.map((w) => w.id).sort()).toEqual(['a', 'c']);
  });

  it('list with whereIn filter', async () => {
    await store.upsertMany([
      { id: 'a', name: 'A', count: 1, active: true },
      { id: 'b', name: 'B', count: 2, active: false },
      { id: 'c', name: 'C', count: 3, active: true },
    ]);
    const got = await store.list({ whereIn: { column: 'id', values: ['a', 'c'] } });
    expect(got.map((w) => w.id).sort()).toEqual(['a', 'c']);
  });

  it('list with orderBy + limit', async () => {
    await store.upsertMany([
      { id: 'a', name: 'A', count: 3, active: true },
      { id: 'b', name: 'B', count: 1, active: true },
      { id: 'c', name: 'C', count: 2, active: true },
    ]);
    const got = await store.list({ orderBy: [{ column: 'count', dir: 'asc' }], limit: 2 });
    expect(got.map((w) => w.count)).toEqual([1, 2]);
  });

  it('list with column projection returns only requested columns', async () => {
    await store.upsert({ id: 'a', name: 'A', count: 7, active: false });
    const got = await store.list({ columns: ['id', 'count'] });
    expect(got).toEqual([{ id: 'a', count: 7 }]);
  });

  it('delete removes row and reports outcome', async () => {
    await store.upsert({ id: 'a', name: 'A', count: 1, active: true });
    await expect(store.delete('a')).resolves.toBe(true);
    await expect(store.delete('a')).resolves.toBe(false);
    expect(await store.count()).toBe(0);
  });

  it('deleteMany returns removed count', async () => {
    await store.upsertMany([
      { id: 'a', name: 'A', count: 1, active: true },
      { id: 'b', name: 'B', count: 2, active: true },
    ]);
    await expect(store.deleteMany(['a', 'b', 'missing'])).resolves.toBe(2);
    expect(await store.count()).toBe(0);
  });

  it('count with filter respects predicates', async () => {
    await store.upsertMany([
      { id: 'a', name: 'A', count: 1, active: true },
      { id: 'b', name: 'B', count: 2, active: false },
    ]);
    expect(await store.count({ where: { active: true } })).toBe(1);
  });

  it('whereIn with empty values yields empty list', async () => {
    await store.upsert({ id: 'a', name: 'A', count: 1, active: true });
    const got = await store.list({ whereIn: { column: 'id', values: [] } });
    expect(got).toEqual([]);
  });
});

describe('DuckDBParquetRecordStore persistence', () => {
  it('survives flush + reopen round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'record-store-persist-'));
    try {
      const a = new DuckDBParquetRecordStore<Widget>({
        dataRoot: dir,
        spec: widgetSpec,
        minFlushIntervalMs: 0,
      });
      await a.upsertMany([
        { id: 'a', name: 'A', count: 1, active: true },
        { id: 'b', name: 'B', count: 2, active: false },
      ]);
      await a.flush();

      const b = new DuckDBParquetRecordStore<Widget>({
        dataRoot: dir,
        spec: widgetSpec,
        minFlushIntervalMs: 0,
      });
      const rows = await b.list({ orderBy: [{ column: 'id', dir: 'asc' }] });
      expect(rows).toEqual([
        { id: 'a', name: 'A', count: 1, active: true },
        { id: 'b', name: 'B', count: 2, active: false },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
