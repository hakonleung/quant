/**
 * Equivalence spec between `InMemoryTimeSeriesStore` and
 * `DuckDBParquetTimeSeriesStore`. Plus a few backend-specific
 * persistence / LSM behaviours.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  TimeSeriesStore,
} from '../../../src/common/storage/ports/time-series-store.port.js';
import { DuckDBParquetTimeSeriesStore } from '../../../src/common/storage/adapters/duckdb-parquet-time-series.store.js';
import { InMemoryTimeSeriesStore } from '../../fakes/in-memory-time-series.store.js';

interface Bar {
  code: string;
  ts: Date;
  close_qfq: number;
  ma5: number;
}

const COLUMNS = [
  { name: 'code', type: 'VARCHAR' as const, nullable: false },
  { name: 'ts', type: 'TIMESTAMP' as const, nullable: false },
  { name: 'close_qfq', type: 'DOUBLE' as const },
  { name: 'ma5', type: 'DOUBLE' as const },
];

interface Backend {
  readonly label: string;
  build: () => Promise<TimeSeriesStore<Bar>>;
  cleanup: () => Promise<void>;
}

function inMemoryBackend(): Backend {
  return {
    label: 'in-memory',
    async build() {
      return new InMemoryTimeSeriesStore<Bar>();
    },
    async cleanup() {
      // nothing
    },
  };
}

function duckdbBackend(): Backend {
  let dir: string | null = null;
  return {
    label: 'duckdb-parquet',
    async build() {
      dir = await mkdtemp(join(tmpdir(), 'ts-store-test-'));
      return new DuckDBParquetTimeSeriesStore<Bar>({
        dataRoot: dir,
        table: 'kline',
        columns: COLUMNS,
      });
    },
    async cleanup() {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
      dir = null;
    },
  };
}

const backends: Backend[] = [inMemoryBackend(), duckdbBackend()];

function bar(code: string, isoDate: string, close: number, ma: number): Bar {
  return { code, ts: new Date(`${isoDate}T00:00:00Z`), close_qfq: close, ma5: ma };
}

describe.each(backends)('TimeSeriesStore [$label]', (backend) => {
  let store: TimeSeriesStore<Bar>;

  beforeEach(async () => {
    store = await backend.build();
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  it('returns empty for read against empty store', async () => {
    await expect(store.read({ entityKeys: ['000001'] })).resolves.toEqual([]);
  });

  it('appendBars then read by code', async () => {
    await store.appendBars([
      bar('000001', '2026-01-01', 10, 9.5),
      bar('000001', '2026-01-02', 11, 9.8),
      bar('000002', '2026-01-01', 20, 19.5),
    ]);
    const rows = await store.read({ entityKeys: ['000001'] });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.close_qfq)).toEqual([10, 11]);
  });

  it('reads sorted by (code asc, ts asc)', async () => {
    await store.appendBars([
      bar('000002', '2026-01-02', 22, 21),
      bar('000001', '2026-01-02', 11, 10),
      bar('000002', '2026-01-01', 20, 19),
      bar('000001', '2026-01-01', 10, 9),
    ]);
    const rows = await store.read({ entityKeys: ['000001', '000002'] });
    expect(rows.map((r) => `${r.code}@${r.ts.toISOString().slice(0, 10)}`)).toEqual([
      '000001@2026-01-01',
      '000001@2026-01-02',
      '000002@2026-01-01',
      '000002@2026-01-02',
    ]);
  });

  it('respects start/end filters inclusive', async () => {
    await store.appendBars([
      bar('000001', '2026-01-01', 10, 9),
      bar('000001', '2026-01-02', 11, 10),
      bar('000001', '2026-01-03', 12, 11),
    ]);
    const rows = await store.read({
      entityKeys: ['000001'],
      start: new Date('2026-01-02T00:00:00Z'),
      end: new Date('2026-01-02T00:00:00Z'),
    });
    expect(rows.map((r) => r.close_qfq)).toEqual([11]);
  });

  it('tail returns last N per entity', async () => {
    await store.appendBars([
      bar('000001', '2026-01-01', 10, 9),
      bar('000001', '2026-01-02', 11, 10),
      bar('000001', '2026-01-03', 12, 11),
      bar('000002', '2026-01-01', 20, 19),
      bar('000002', '2026-01-02', 22, 21),
    ]);
    const rows = await store.read({ entityKeys: ['000001', '000002'], tail: 1 });
    expect(rows.map((r) => `${r.code}@${r.close_qfq}`).sort()).toEqual(['000001@12', '000002@22']);
  });

  it('column projection returns only requested columns', async () => {
    await store.appendBars([bar('000001', '2026-01-01', 10, 9.5)]);
    const rows = await store.read({ entityKeys: ['000001'], columns: ['code', 'close_qfq'] });
    expect(rows).toHaveLength(1);
    const first = rows[0];
    if (first === undefined) throw new Error('expected one row');
    expect(Object.keys(first).sort()).toEqual(['close_qfq', 'code']);
  });

  it('later append for same (code, ts) overrides earlier value', async () => {
    await store.appendBars([bar('000001', '2026-01-01', 10, 9)]);
    await store.appendBars([bar('000001', '2026-01-01', 99, 88)]);
    const rows = await store.read({ entityKeys: ['000001'] });
    expect(rows).toHaveLength(1);
    const first = rows[0];
    if (first === undefined) throw new Error('expected one row');
    expect(first.close_qfq).toBe(99);
  });

  it('lastTimestamp / lastTimestamps return latest ts per code', async () => {
    await store.appendBars([
      bar('000001', '2026-01-01', 10, 9),
      bar('000001', '2026-01-03', 12, 11),
      bar('000002', '2026-01-02', 20, 19),
    ]);
    await expect(store.lastTimestamp('000001')).resolves.toEqual(new Date('2026-01-03T00:00:00Z'));
    const map = await store.lastTimestamps(['000001', '000002', 'missing']);
    expect(map.get('000001')).toEqual(new Date('2026-01-03T00:00:00Z'));
    expect(map.get('000002')).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(map.has('missing')).toBe(false);
  });

  it('full-universe read with no entityKeys returns everything', async () => {
    await store.appendBars([
      bar('000001', '2026-01-01', 10, 9),
      bar('300100', '2026-01-01', 30, 29),
      bar('600000', '2026-01-01', 60, 59),
    ]);
    const rows = await store.read({});
    expect(rows.map((r) => r.code).sort()).toEqual(['000001', '300100', '600000']);
  });
});

describe('DuckDBParquetTimeSeriesStore LSM behaviour', () => {
  it('routes rows to 3-digit prefix partitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ts-store-lsm-'));
    try {
      const store = new DuckDBParquetTimeSeriesStore<Bar>({
        dataRoot: dir,
        table: 'kline',
        columns: COLUMNS,
      });
      await store.appendBars([
        bar('000001', '2026-01-01', 10, 9),
        bar('300100', '2026-01-01', 30, 29),
        bar('600000', '2026-01-01', 60, 59),
        bar('688001', '2026-01-01', 68, 67),
      ]);
      const prefixes = await readdir(join(dir, 'kline'));
      expect(prefixes.sort()).toEqual(['000', '300', '600', '688']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('each append produces a delta file, compaction merges them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ts-store-compact-'));
    try {
      const store = new DuckDBParquetTimeSeriesStore<Bar>({
        dataRoot: dir,
        table: 'kline',
        columns: COLUMNS,
      });
      await store.appendBars([bar('000001', '2026-01-01', 10, 9)]);
      await store.appendBars([bar('000001', '2026-01-02', 11, 10)]);
      await store.appendBars([bar('000001', '2026-01-03', 12, 11)]);

      const beforeFiles = (await readdir(join(dir, 'kline', '000'))).filter((f) =>
        f.endsWith('.parquet'),
      );
      expect(beforeFiles).toHaveLength(3);
      expect(beforeFiles.every((f) => f.includes('delta'))).toBe(true);

      await store.compact('000');
      const afterFiles = (await readdir(join(dir, 'kline', '000'))).filter((f) =>
        f.endsWith('.parquet'),
      );
      expect(afterFiles).toEqual(['00000000000000-main.parquet']);

      // Data still readable & identical after compaction
      const rows = await store.read({ entityKeys: ['000001'] });
      expect(rows.map((r) => r.close_qfq)).toEqual([10, 11, 12]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reopen reads back compacted + delta data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ts-store-reopen-'));
    try {
      const a = new DuckDBParquetTimeSeriesStore<Bar>({
        dataRoot: dir,
        table: 'kline',
        columns: COLUMNS,
      });
      await a.appendBars([
        bar('000001', '2026-01-01', 10, 9),
        bar('000001', '2026-01-02', 11, 10),
      ]);
      await a.compact('000');
      await a.appendBars([bar('000001', '2026-01-03', 12, 11)]);

      const b = new DuckDBParquetTimeSeriesStore<Bar>({
        dataRoot: dir,
        table: 'kline',
        columns: COLUMNS,
      });
      const rows = await b.read({ entityKeys: ['000001'] });
      expect(rows.map((r) => r.close_qfq)).toEqual([10, 11, 12]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
