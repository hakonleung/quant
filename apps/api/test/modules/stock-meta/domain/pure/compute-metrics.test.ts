/**
 * Unit tests for `computeMetrics` — pure port of the Python
 * `compute_metrics`. Mirrors
 * `services/py/tests/unit/quant_core/domain/pure/test_compute_metrics.py`.
 */

import type { StockMetaDto } from '@quant/shared';

import {
  computeMetrics,
  type BarLike,
} from '../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';

const BASE_META: StockMetaDto = {
  code: '000001',
  name: '测试',
  name_pinyin: 'CS',
  industries: 'bank',
  list_date: '2020-01-01',
  float_pct: '1',
  updated_at: '2026-01-01T00:00:00+00:00',
  total_share: null,
  float_share: null,
  net_assets: null,
  net_assets_period: null,
  quarterlies: [],
  financials_updated_at: null,
};

function bar(dayOffset: number, close: number): BarLike {
  const base = new Date('2026-01-01T00:00:00Z');
  const d = new Date(base.getTime() + dayOffset * 86_400_000);
  const iso = d.toISOString().slice(0, 10);
  return { trade_date: iso, close_qfq: close };
}

describe('computeMetrics', () => {
  it('empty bars yield every-null row', () => {
    const m = computeMetrics(BASE_META, []);
    expect(m.asof).toBeNull();
    expect(m.price).toBeNull();
    expect(m.ret_1d).toBeNull();
    expect(m.ret_250d).toBeNull();
    expect(m.mkt_cap).toBeNull();
    expect(m.gross_margin_ttm).toBeNull();
  });

  it('ret_1d = (latest - prev) / prev', () => {
    const bars = [bar(0, 10), bar(1, 11)];
    const m = computeMetrics(BASE_META, bars);
    expect(m.asof).toBe(bars[bars.length - 1]!.trade_date);
    // 11/10 - 1 = 0.1
    expect(m.ret_1d?.toString()).toBe('0.1');
  });

  it('skips windows longer than available history', () => {
    const bars = [bar(0, 10), bar(1, 10.1), bar(2, 10.2)];
    const m = computeMetrics(BASE_META, bars);
    expect(m.ret_1d).not.toBeNull();
    expect(m.ret_5d).toBeNull();
    expect(m.ret_250d).toBeNull();
  });

  it('non-positive close → ret_* are all null', () => {
    const bars = [bar(0, 10), bar(1, 0)];
    const m = computeMetrics(BASE_META, bars);
    expect(m.ret_1d).toBeNull();
    expect(m.price).toBeNull();
  });

  it('ret_20d uses bar 20 positions before latest', () => {
    const bars = Array.from({ length: 21 }, (_, i) => bar(i, 10 + i));
    const m = computeMetrics(BASE_META, bars);
    // (30 - 10) / 10 = 2
    expect(m.ret_20d?.toString()).toBe('2');
  });
});
