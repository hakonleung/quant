import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TaAnalysis } from '@quant/shared';

import {
  TA_CACHE_TABLE_SPEC,
  TaCacheStore,
  type TaCacheRow,
} from '../../../src/modules/ta/ta-cache.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ta-cache-'));
}

const FIXTURE: TaAnalysis = {
  code: '000001',
  asof: '2026-05-04',
  barsCount: 250,
  supportLevels: [],
  resistanceLevels: [],
  trend: { direction: 'up', horizonDays: 20, confidence: 0.7, rationale: 'r' },
  patterns: [],
  caveats: [],
  provider: 'moonshot',
  cachedAt: '2026-05-04T07:15:00.000Z',
};

describe('TaCacheStore', () => {
  it('returns null when no row exists', async () => {
    const record = new InMemoryRecordStore<TaCacheRow>(TA_CACHE_TABLE_SPEC);
    const store = new TaCacheStore(record, '/unused');
    await expect(store.get('000001', '2026-05-04')).resolves.toBeNull();
  });

  it('put then get with same asof returns the payload', async () => {
    const record = new InMemoryRecordStore<TaCacheRow>(TA_CACHE_TABLE_SPEC);
    const store = new TaCacheStore(record, '/unused');
    await store.put(FIXTURE);
    const got = await store.get('000001', '2026-05-04');
    expect(got?.code).toBe('000001');
    expect(got?.asof).toBe('2026-05-04');
  });

  it('returns null when asof does not match the cached row', async () => {
    const record = new InMemoryRecordStore<TaCacheRow>(TA_CACHE_TABLE_SPEC);
    const store = new TaCacheStore(record, '/unused');
    await store.put(FIXTURE);
    await expect(store.get('000001', '2026-05-05')).resolves.toBeNull();
  });

  it('migrates legacy {code}.json on first get and renames to .bak', async () => {
    const dir = await tmpDir();
    const taDir = path.join(dir, 'ta');
    await fs.mkdir(taDir, { recursive: true });
    const legacy = path.join(taDir, '000001.json');
    await fs.writeFile(legacy, JSON.stringify(FIXTURE));

    const record = new InMemoryRecordStore<TaCacheRow>(TA_CACHE_TABLE_SPEC);
    const store = new TaCacheStore(record, dir);

    const got = await store.get('000001', '2026-05-04');
    expect(got?.code).toBe('000001');
    await expect(record.count()).resolves.toBe(1);
    await expect(fs.access(legacy)).rejects.toBeDefined();
    await expect(fs.access(`${legacy}.bak`)).resolves.toBeUndefined();
  });

  it('returns null and does not throw when legacy json is malformed', async () => {
    const dir = await tmpDir();
    const taDir = path.join(dir, 'ta');
    await fs.mkdir(taDir, { recursive: true });
    await fs.writeFile(path.join(taDir, '000001.json'), 'not-json');

    const record = new InMemoryRecordStore<TaCacheRow>(TA_CACHE_TABLE_SPEC);
    const store = new TaCacheStore(record, dir);

    await expect(store.get('000001', '2026-05-04')).resolves.toBeNull();
  });
});
