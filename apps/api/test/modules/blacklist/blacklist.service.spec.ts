import type { StockSnapshotDto } from '@quant/shared';

import { FrozenClock } from '../../../src/common/clock.js';
import { BlacklistService } from '../../../src/modules/blacklist/blacklist.service.js';
import {
  BLACKLIST_TABLE_SPEC,
  BlacklistStore,
  type BlacklistRow,
} from '../../../src/modules/blacklist/blacklist.store.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

function makeStore(): BlacklistStore {
  return new BlacklistStore(new InMemoryRecordStore<BlacklistRow>(BLACKLIST_TABLE_SPEC));
}

function snap(
  code: string,
  returns: {
    ret_20d?: string | null;
    ret_90d?: string | null;
    ret_250d?: string | null;
  },
  asof: string | null = '2026-05-15',
): StockSnapshotDto {
  return {
    meta: {
      code,
      name: code,
      name_pinyin: code,
      industries: '银行',
      list_date: '2001-01-01',
      float_pct: '1',
      updated_at: '2026-05-01T00:00:00+00:00',
      total_share: null,
      float_share: null,
      net_assets: null,
      net_assets_period: null,
      quarterlies: [],
      financials_updated_at: null,
    },
    price: null,
    asof,
    derived: {
      mkt_cap: null,
      float_mkt_cap: null,
      pe_ttm: null,
      pe_dynamic: null,
      pb: null,
      peg: null,
      gross_margin_ttm: null,
      wcmi: null,
      wcmi_rhythm: null,
      wcmi_ma_support: null,
      wcmi_up_wave: null,
      wcmi_yang_dom: null,
      wcmi_shadow_clean: null,
      wcmi_stage_gain: null,
      wcmi_crash_avoid: null, wcmi_recent_strength: null,
    },
    returns: {
      ret_1d: null,
      ret_5d: null,
      ret_10d: null,
      ret_20d: returns.ret_20d ?? null,
      ret_90d: returns.ret_90d ?? null,
      ret_250d: returns.ret_250d ?? null,
    },
    dde: null,
  };
}

function fakeMeta(snapshots: readonly StockSnapshotDto[]): StockMetaService {
  return { snapshotAll: async () => snapshots } as unknown as StockMetaService;
}

const FROZEN = new Date('2026-05-16T07:15:00.000Z');

describe('BlacklistService.refresh', () => {
  it('blacklists A-share codes whose every stage return is at or below threshold', async () => {
    const store = makeStore();
    await store.load();
    const svc = new BlacklistService(
      store,
      fakeMeta([
        snap('000001', { ret_20d: '0.05', ret_90d: '0.10', ret_250d: '0.50' }),
      ]),
      new FrozenClock(FROZEN),
    );

    const result = await svc.refresh('t-1');

    expect(result.codes).toEqual(['000001']);
    expect(result.asof).toBe('2026-05-15');
    expect(result.universeSize).toBe(1);
    expect(result.computedAt).toBe(FROZEN.toISOString());
    expect(store.has('000001')).toBe(true);
  });

  it('keeps codes whose any stage return exceeds its threshold', async () => {
    const store = makeStore();
    await store.load();
    const svc = new BlacklistService(
      store,
      fakeMeta([
        snap('600519', { ret_20d: '0.40' }),
        snap('600520', { ret_90d: '0.70' }),
        snap('600521', { ret_250d: '2.00' }),
      ]),
      new FrozenClock(FROZEN),
    );

    const result = await svc.refresh('t-2');

    expect(result.codes).toEqual([]);
  });

  it('keeps codes whose stage returns are all null (insufficient history)', async () => {
    const store = makeStore();
    await store.load();
    const svc = new BlacklistService(
      store,
      fakeMeta([snap('301999', {})]),
      new FrozenClock(FROZEN),
    );

    const result = await svc.refresh('t-3');

    expect(result.codes).toEqual([]);
    expect(result.universeSize).toBe(1);
  });

  it('excludes non-A-share codes from both the universe and the result', async () => {
    const store = makeStore();
    await store.load();
    const svc = new BlacklistService(
      store,
      fakeMeta([
        snap('000001', { ret_20d: '0.05', ret_90d: '0.10', ret_250d: '0.50' }),
        snap('00700', { ret_20d: '0.05' }), // HK code
        snap('AAPL', { ret_20d: '0.05' }), // US ticker
      ]),
      new FrozenClock(FROZEN),
    );

    const result = await svc.refresh('t-4');

    expect(result.codes).toEqual(['000001']);
    expect(result.universeSize).toBe(1);
  });

  it('sorts the output codes lexicographically', async () => {
    const store = makeStore();
    await store.load();
    const svc = new BlacklistService(
      store,
      fakeMeta([
        snap('600519', { ret_20d: '0.05' }),
        snap('000001', { ret_20d: '0.05' }),
        snap('300999', { ret_20d: '0.05' }),
      ]),
      new FrozenClock(FROZEN),
    );

    const result = await svc.refresh('t-5');

    expect(result.codes).toEqual(['000001', '300999', '600519']);
  });

  it('uses the max snapshot.asof as the result asof; falls back to clock today when none', async () => {
    const store = makeStore();
    await store.load();
    const svc = new BlacklistService(
      store,
      fakeMeta([
        snap('000001', { ret_20d: '0.05' }, '2026-05-14'),
        snap('600519', { ret_20d: '0.05' }, '2026-05-15'),
      ]),
      new FrozenClock(FROZEN),
    );

    const result = await svc.refresh('t-6');
    expect(result.asof).toBe('2026-05-15');

    const svcFallback = new BlacklistService(
      store,
      fakeMeta([snap('000001', { ret_20d: '0.05' }, null)]),
      new FrozenClock(FROZEN),
    );
    const fallback = await svcFallback.refresh('t-6b');
    expect(fallback.asof).toBe('2026-05-16');
  });

  it('skips returns that fail to parse as finite numbers', async () => {
    const store = makeStore();
    await store.load();
    const svc = new BlacklistService(
      store,
      fakeMeta([snap('000001', { ret_20d: 'NaN', ret_90d: '0.05' })]),
      new FrozenClock(FROZEN),
    );

    const result = await svc.refresh('t-7');

    // ret_20d unparseable → ignored; ret_90d below threshold → blacklist.
    expect(result.codes).toEqual(['000001']);
  });

  it('uses the injected clock for computedAt', async () => {
    const store = makeStore();
    await store.load();
    const a = new Date('2026-01-01T00:00:00Z');
    const b = new Date('2026-12-31T23:59:59Z');
    const svcA = new BlacklistService(store, fakeMeta([]), new FrozenClock(a));
    const svcB = new BlacklistService(store, fakeMeta([]), new FrozenClock(b));

    expect((await svcA.refresh('t-a')).computedAt).toBe(a.toISOString());
    expect((await svcB.refresh('t-b')).computedAt).toBe(b.toISOString());
  });
});
