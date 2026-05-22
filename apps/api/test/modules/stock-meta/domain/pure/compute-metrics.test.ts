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
import {
  extractRawFeatures,
  scoreUniverse,
  type ScoringInput,
} from '../../../../../src/modules/stock-meta/domain/pure/wcmi-scoring.js';

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
  // Default OHLC: zero-range bar at `close` ⇒ no wick contribution.
  // Wick-sensitive tests use {@link ohlcBar} below.
  return {
    trade_date: iso,
    open_qfq: close,
    high_qfq: close,
    low_qfq: close,
    close_qfq: close,
    volume: 0,
    turnover: 0,
  };
}

/** Bar with explicit OHLC — for wick-sensitive tests. */
function ohlcBar(
  dayOffset: number,
  open: number,
  high: number,
  low: number,
  close: number,
): BarLike {
  const base = new Date('2026-01-01T00:00:00Z');
  const d = new Date(base.getTime() + dayOffset * 86_400_000);
  return {
    trade_date: d.toISOString().slice(0, 10),
    open_qfq: open,
    high_qfq: high,
    low_qfq: low,
    close_qfq: close,
    volume: 0,
    turnover: 0,
  };
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

  describe('wcmi (per-code path)', () => {
    it('always returns null on the per-code projector (batch fills it later)', () => {
      const closes: number[] = [100];
      for (let i = 1; i <= 90; i += 1) closes.push(closes[i - 1]! * 1.01);
      const bars = closes.map((c, i) => bar(i, c));
      const m = computeMetrics(BASE_META, bars);
      expect(m.wcmi).toBeNull();
    });
  });

  describe('wcmi cross-sectional scoring (extractRawFeatures + scoreUniverse)', () => {
    it('extractRawFeatures: returns null when history < 11 bars', () => {
      const bars = Array.from({ length: 10 }, (_, i) => bar(i, 10 + i));
      expect(extractRawFeatures(bars)).toBeNull();
    });

    it('extractRawFeatures: returns null on the empty-bars branch', () => {
      expect(extractRawFeatures([])).toBeNull();
    });

    it('extractRawFeatures: populates r10 + r5 for a healthy short-history series', () => {
      // 12 closes ⇒ ret_5 and ret_10 available; ret_20/r60/r90 null.
      const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
      const bars = closes.map((c, i) => bar(i, c));
      const raw = extractRawFeatures(bars)!;
      expect(raw).not.toBeNull();
      expect(raw.r5).not.toBeNull();
      expect(raw.r10).toBeGreaterThan(0);
      expect(raw.r20).toBeNull();
      expect(raw.r90).toBeNull();
      expect(raw.greenRate).toBe(1); // every bar closes up vs prev
    });

    it('extractRawFeatures: counts a sealed 一字涨停 into pFomoAbsolute', () => {
      const closes: number[] = [100];
      for (let i = 1; i <= 89; i += 1) closes.push(closes[i - 1]! * 1.005);
      const bars: BarLike[] = closes.map((c, i) => bar(i, c));
      const sealedClose = closes[closes.length - 1]! * 1.1;
      bars.push(ohlcBar(90, sealedClose, sealedClose, sealedClose, sealedClose));
      const raw = extractRawFeatures(bars)!;
      // Sealed limit-up adds at least LIMIT_UP_PEN (20) to P_fomo.
      expect(raw.pFomoAbsolute).toBeGreaterThanOrEqual(20);
    });

    it('scoreUniverse: gate-failed codes (ret_10d ≤ 0) get null', () => {
      // 91 bars descending — ret_10d strictly negative.
      const closes = Array.from({ length: 91 }, (_, i) => 100 - i * 0.5);
      const bars = closes.map((c, i) => bar(i, c));
      const raw = extractRawFeatures(bars)!;
      expect(raw.r10).toBeLessThan(0);
      const out = scoreUniverse([{ code: 'A', raw }]);
      expect(out.get('A')).toBeNull();
    });

    it('scoreUniverse: ranks survivors and outputs `[-1, +1]` finals', () => {
      // Three survivors with monotonically stronger trends. The
      // strongest must score higher than the weakest under the
      // module-blend.
      const inputs: ScoringInput[] = [];
      for (const [code, daily] of [
        ['weak', 1.001],
        ['mid', 1.005],
        ['strong', 1.02],
      ] as const) {
        const closes: number[] = [100];
        for (let i = 1; i <= 90; i += 1) closes.push(closes[i - 1]! * daily);
        const raw = extractRawFeatures(closes.map((c, i) => bar(i, c)))!;
        inputs.push({ code, raw });
      }
      const out = scoreUniverse(inputs);
      const weak = out.get('weak')!;
      const strong = out.get('strong')!;
      expect(weak).not.toBeNull();
      expect(strong).not.toBeNull();
      expect(strong).toBeGreaterThan(weak);
      // Range guarantee for the blend.
      for (const v of out.values()) {
        if (v === null) continue;
        expect(v).toBeGreaterThanOrEqual(-1000);
        expect(v).toBeLessThanOrEqual(1000);
      }
    });

    it('scoreUniverse: empty input yields empty map', () => {
      expect(scoreUniverse([]).size).toBe(0);
    });
  });
});
