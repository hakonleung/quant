import { KlineWriterService } from '../../../src/modules/kline/kline-writer.service.js';
import type { KlineRow } from '../../../src/modules/kline/kline.row.js';
import { InMemoryTimeSeriesStore } from '../../fakes/in-memory-time-series.store.js';

function makeRow(over: Partial<KlineRow>): KlineRow {
  return {
    code: '000001',
    ts: new Date('2026-05-04T00:00:00Z'),
    open_qfq: 10,
    high_qfq: 10.5,
    low_qfq: 9.5,
    close_qfq: 10.2,
    volume: 1_000_000,
    amount: 10_200_000,
    turnover_rate: 0.01,
    ma5: 10,
    ma10: 10,
    ma20: 10,
    ma60: 10,
    ...over,
  };
}

describe('KlineWriterService', () => {
  it('writes a batch to the store', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    const writer = new KlineWriterService(store);
    await writer.appendBars([
      makeRow({ code: '000001', ts: new Date('2026-05-01T00:00:00Z') }),
      makeRow({ code: '000001', ts: new Date('2026-05-02T00:00:00Z') }),
      makeRow({ code: '600000', ts: new Date('2026-05-01T00:00:00Z') }),
    ]);
    const rows = await store.read({});
    expect(rows.map((r) => `${r.code}@${r.ts.toISOString().slice(0, 10)}`).sort()).toEqual([
      '000001@2026-05-01',
      '000001@2026-05-02',
      '600000@2026-05-01',
    ]);
  });

  it('empty batch is a no-op (no spurious write)', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    const writer = new KlineWriterService(store);
    const spy = jest.spyOn(store, 'appendBars');
    await writer.appendBars([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('appendBarsForCode stamps the code onto every row', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    const writer = new KlineWriterService(store);
    await writer.appendBarsForCode('000123', [
      makeRow({ code: 'wrong', ts: new Date('2026-05-01T00:00:00Z') }),
      makeRow({ code: '000123', ts: new Date('2026-05-02T00:00:00Z') }),
    ]);
    const rows = await store.read({});
    expect(rows.every((r) => r.code === '000123')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('compact delegates to the store', async () => {
    const store = new InMemoryTimeSeriesStore<KlineRow>();
    const writer = new KlineWriterService(store);
    const spy = jest.spyOn(store, 'compact');
    await writer.compact('000');
    expect(spy).toHaveBeenCalledWith('000');
  });
});
