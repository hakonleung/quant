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
  extractWcmiSubscores,
  scoreUniverse,
  WCMI_CONFIG,
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
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
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
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
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

  describe('wcmi v2 cross-sectional scoring (extractWcmiSubscores + scoreUniverse)', () => {
    it('extractWcmiSubscores: returns null when history < 30 bars', () => {
      const bars = Array.from({ length: 20 }, (_, i) => bar(i, 10 + i));
      expect(extractWcmiSubscores(bars, WCMI_CONFIG)).toBeNull();
    });

    it('extractWcmiSubscores: returns null on the empty-bars branch', () => {
      expect(extractWcmiSubscores([], WCMI_CONFIG)).toBeNull();
    });

    it('extractWcmiSubscores: populates all sub-scores for a healthy 90-bar series', () => {
      const closes: number[] = [100];
      for (let i = 1; i <= 90; i += 1) closes.push(closes[i - 1]! * 1.005);
      const bars = closes.map((c, i) => bar(i, c));
      const raw = extractWcmiSubscores(bars, WCMI_CONFIG)!;
      expect(raw).not.toBeNull();
      expect(raw.windowLen).toBe(90);
      expect(raw.passesGate).toBe(true);
      expect(Number.isFinite(raw.stageGain)).toBe(true);
    });

    it('extractWcmiSubscores: passesGate=false for a net-down window', () => {
      const closes = Array.from({ length: 91 }, (_, i) => 100 - i * 0.5);
      const bars = closes.map((c, i) => bar(i, c));
      const raw = extractWcmiSubscores(bars, WCMI_CONFIG)!;
      expect(raw.passesGate).toBe(false);
    });

    it('scoreUniverse: gate-failed codes get null', () => {
      const closes = Array.from({ length: 91 }, (_, i) => 100 - i * 0.5);
      const bars = closes.map((c, i) => bar(i, c));
      const raw = extractWcmiSubscores(bars, WCMI_CONFIG)!;
      const out = scoreUniverse([{ code: 'A', raw }], WCMI_CONFIG);
      expect(out.get('A')).toBeNull();
    });

    it('scoreUniverse: ranks survivors and bounds composite to [0, 1000]', () => {
      const inputs: ScoringInput[] = [];
      for (const [code, daily] of [
        ['weak', 1.001],
        ['mid', 1.005],
        ['strong', 1.02],
      ] as const) {
        const closes: number[] = [100];
        for (let i = 1; i <= 90; i += 1) closes.push(closes[i - 1]! * daily);
        const raw = extractWcmiSubscores(closes.map((c, i) => bar(i, c)), WCMI_CONFIG)!;
        inputs.push({ code, raw });
      }
      const out = scoreUniverse(inputs, WCMI_CONFIG);
      const weak = out.get('weak');
      const strong = out.get('strong');
      expect(weak).not.toBeNull();
      expect(strong).not.toBeNull();
      expect(strong!.composite).toBeGreaterThan(weak!.composite);
      for (const v of out.values()) {
        if (v === null) continue;
        expect(v.composite).toBeGreaterThanOrEqual(0);
        expect(v.composite).toBeLessThanOrEqual(1000);
      }
    });

    it('scoreUniverse: empty input yields empty map', () => {
      expect(scoreUniverse([], WCMI_CONFIG).size).toBe(0);
    });
  });
});

// Silence the unused-import warning when this file is run with no
// wick-sensitive assertions in the test list.
void ohlcBar;
