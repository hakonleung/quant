import { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';
import type { KlineRow } from '../../../src/modules/kline/kline.row.js';
import { InMemoryTimeSeriesStore } from '../../fakes/in-memory-time-series.store.js';

function row(code: string, isoDate: string, close: number): KlineRow {
  return {
    code,
    ts: new Date(`${isoDate}T00:00:00Z`),
    open_qfq: close - 0.2,
    high_qfq: close + 0.5,
    low_qfq: close - 0.5,
    close_qfq: close,
    volume: 1_000_000,
    amount: close * 1_000_000,
    turnover_rate: 0.01,
    ma5: close,
    ma10: close,
    ma20: close,
    ma60: close,
  };
}

describe('KlineReaderService', () => {
  it('lastNForCode returns rows mapped to KlineBar shape', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    await store.appendBars([
      row('000001', '2026-05-01', 10),
      row('000001', '2026-05-02', 11),
      row('000001', '2026-05-03', 12),
    ]);
    const reader = new KlineReaderService(store);

    const bars = await reader.lastNForCode('000001', 2);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.date).toBe('2026-05-02');
    expect(bars[1]?.date).toBe('2026-05-03');
    expect(bars[1]?.close).toBe(12);
    // Field renaming: amount → turnover, turnover_rate → turnoverRate
    expect(bars[1]?.turnover).toBe(12 * 1_000_000);
    expect(bars[1]?.turnoverRate).toBe(0.01);
  });

  it('lastNForCode returns empty array when no rows for code', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    const reader = new KlineReaderService(store);
    await expect(reader.lastNForCode('999999', 5)).resolves.toEqual([]);
  });

  it('lastNBulk groups rows by code', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    await store.appendBars([
      row('000001', '2026-05-01', 10),
      row('000001', '2026-05-02', 11),
      row('600000', '2026-05-01', 20),
    ]);
    const reader = new KlineReaderService(store);

    const out = await reader.lastNBulk(['000001', '600000', 'missing'], 5);
    expect(Object.keys(out).sort()).toEqual(['000001', '600000']);
    expect(out['000001']).toHaveLength(2);
    expect(out['600000']).toHaveLength(1);
  });

  it('lastNBulk returns {} for empty codes input', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    const reader = new KlineReaderService(store);
    await expect(reader.lastNBulk([], 5)).resolves.toEqual({});
  });

  it('lastTradeDate / lastTradeDates report watermarks', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    await store.appendBars([
      row('000001', '2026-05-01', 10),
      row('000001', '2026-05-03', 12),
      row('600000', '2026-05-02', 20),
    ]);
    const reader = new KlineReaderService(store);

    await expect(reader.lastTradeDate('000001')).resolves.toEqual(new Date('2026-05-03T00:00:00Z'));
    await expect(reader.lastTradeDate('missing')).resolves.toBeNull();

    const map = await reader.lastTradeDates(['000001', '600000', 'missing']);
    expect(map.size).toBe(2);
    expect(map.get('000001')).toEqual(new Date('2026-05-03T00:00:00Z'));
  });
});
