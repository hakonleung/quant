import type { TaAnalysis } from '@quant/shared';

import {
  TA_CACHE_TABLE_SPEC,
  TaCacheStore,
  type TaCacheRow,
} from '../../../src/modules/ta/ta-cache.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

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
    const store = new TaCacheStore(record);
    await expect(store.get('000001', '2026-05-04')).resolves.toBeNull();
  });

  it('put then get with same asof returns the payload', async () => {
    const record = new InMemoryRecordStore<TaCacheRow>(TA_CACHE_TABLE_SPEC);
    const store = new TaCacheStore(record);
    await store.put(FIXTURE);
    const got = await store.get('000001', '2026-05-04');
    expect(got?.code).toBe('000001');
    expect(got?.asof).toBe('2026-05-04');
  });

  it('returns null when asof does not match the cached row', async () => {
    const record = new InMemoryRecordStore<TaCacheRow>(TA_CACHE_TABLE_SPEC);
    const store = new TaCacheStore(record);
    await store.put(FIXTURE);
    await expect(store.get('000001', '2026-05-05')).resolves.toBeNull();
  });
});
