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

  describe('wcmi (volatility-normalised)', () => {
    it('matches the closed-form value on a hand-crafted series', () => {
      // 91 bars. Constant ±0.1 alternating from a fixed base produces a
      // single 0.1 daily pct change on the last bar and predictable
      // earlier history. We keep closes flat at 10 except the final
      // bar at 11 → only daily[89] = 0.1, the rest are 0.
      // For every stage window T ∈ {5, 10, 20, 90}:
      //   ret_T = (11 - 10) / 10 = 0.1
      //   σ_T  = sample stddev of T daily values, one of which is 0.1
      //          and (T-1) are 0 ⇒ mean = 0.1/T,
      //          variance = ((0.1 − 0.1/T)² + (T−1)·(0.1/T)²) / (T−1)
      //                   = 0.01 · (1/T) ⇒ σ_T = 0.1 / √T
      //   R'_T = ret_T / σ_T = 0.1 / (0.1/√T) = √T
      // wcmi = 2·√5 + 5·√10 + 4·√20 + 1·√90.
      const closes = new Array<number>(91).fill(10);
      closes[90] = 11;
      const bars = closes.map((c, i) => bar(i, c));
      const m = computeMetrics(BASE_META, bars);
      expect(m.ret_5d?.toString()).toBe('0.1');
      expect(m.ret_90d?.toString()).toBe('0.1');
      const expected =
        2 * Math.sqrt(5) + 5 * Math.sqrt(10) + 4 * Math.sqrt(20) + 1 * Math.sqrt(90);
      const got = Number(m.wcmi!.toString());
      expect(got).toBeCloseTo(expected, 8);
    });

    it('is positive when ret_* > 0 with non-zero volatility', () => {
      // 91 bars where prices drift up with small noise — ret_* are
      // positive, σ_T > 0, so wcmi must be > 0 and finite.
      const rng = mulberry32(42);
      const closes: number[] = [100];
      for (let i = 1; i <= 90; i += 1) {
        const drift = 0.01;
        const noise = (rng() - 0.5) * 0.02;
        closes.push(closes[i - 1]! * (1 + drift + noise));
      }
      const bars = closes.map((c, i) => bar(i, c));
      const m = computeMetrics(BASE_META, bars);
      expect(m.ret_90d).not.toBeNull();
      expect(m.wcmi).not.toBeNull();
      const v = Number(m.wcmi!.toString());
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    });

    it('is null when any of the four stage returns is null', () => {
      // Only 11 bars → ret_5d / ret_10d exist but ret_20d / ret_90d are null.
      const bars = Array.from({ length: 11 }, (_, i) => bar(i, 10 + i));
      const m = computeMetrics(BASE_META, bars);
      expect(m.ret_5d).not.toBeNull();
      expect(m.ret_20d).toBeNull();
      expect(m.wcmi).toBeNull();
    });

    it('is null when σ_T = 0 (no daily movement in any stage window)', () => {
      // Flat price line — every daily pct change is exactly 0, so
      // every σ_T is 0 and `ret/σ` is undefined → wcmi must be null.
      const bars = Array.from({ length: 91 }, (_, i) => bar(i, 50));
      const m = computeMetrics(BASE_META, bars);
      expect(m.ret_5d?.toString()).toBe('0');
      expect(m.wcmi).toBeNull();
    });

    it('is null on the empty-bars branch', () => {
      const m = computeMetrics(BASE_META, []);
      expect(m.wcmi).toBeNull();
    });
  });
});

/** Deterministic PRNG so the "with noise" test stays reproducible (CLAUDE.md §2.8). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
