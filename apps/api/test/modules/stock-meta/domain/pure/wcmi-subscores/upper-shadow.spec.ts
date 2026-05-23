import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { computeUpperShadowClean } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/upper-shadow.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/config.js';

function bar(prevClose: number, open: number, high: number, low: number, close: number): BarLike[] {
  const prev: BarLike = {
    trade_date: '2025-12-31',
    open_qfq: prevClose,
    high_qfq: prevClose,
    low_qfq: prevClose,
    close_qfq: prevClose,
    volume: 0,
    turnover: 0,
    ma5: null, ma10: null, ma20: null, ma60: null,
  };
  const cur: BarLike = {
    trade_date: '2026-01-01',
    open_qfq: open,
    high_qfq: high,
    low_qfq: low,
    close_qfq: close,
    volume: 0,
    turnover: 0,
    ma5: null, ma10: null, ma20: null, ma60: null,
  };
  return [prev, cur];
}

it('computeUpperShadowClean: fewer than 2 bars returns 1', () => {
  const singleBar: BarLike = {
    trade_date: '2026-01-01',
    open_qfq: 100, high_qfq: 105, low_qfq: 98, close_qfq: 102,
    volume: 0, turnover: 0, ma5: null, ma10: null, ma20: null, ma60: null,
  };
  expect(computeUpperShadowClean([singleBar], WCMI_CONFIG)).toBe(1);
});

it('computeUpperShadowClean: no upper shadow → score is 1', () => {
  // close=high=open: upper shadow=0
  const bars = bar(100, 100, 100, 98, 100);
  expect(computeUpperShadowClean(bars, WCMI_CONFIG)).toBeCloseTo(1, 5);
});

it('computeUpperShadowClean: prev_close <= 0 → bar skipped → totalWeight=0 → returns 1', () => {
  const bars = bar(0, 100, 110, 98, 105);
  expect(computeUpperShadowClean(bars, WCMI_CONFIG)).toBe(1);
});

it('computeUpperShadowClean: yang bar weighted 1.5x (shadow penalty heavier)', () => {
  // yang bar (close>open) with large upper shadow vs yin bar with same shadow
  const yangBars = bar(100, 100, 110, 99, 105);  // yang: close(105)>open(100), high=110
  const yinBars = bar(100, 105, 110, 99, 100);   // yin: close(100)<open(105), high=110
  const yangScore = computeUpperShadowClean(yangBars, WCMI_CONFIG);
  const yinScore = computeUpperShadowClean(yinBars, WCMI_CONFIG);
  expect(yangScore).toBeLessThan(yinScore);
});

it('computeUpperShadowClean: body=0 uses fallback divisor (no division by zero)', () => {
  // open=close=100, high=105 → body=0 → uses MIN_DIVISOR_PCT
  const bars = bar(100, 100, 105, 98, 100);
  expect(Number.isFinite(computeUpperShadowClean(bars, WCMI_CONFIG))).toBe(true);
});

it('computeUpperShadowClean: range=0 (all same) uses fallback divisor', () => {
  // flat candle: open=close=high=low
  const bars = bar(100, 100, 100, 100, 100);
  expect(Number.isFinite(computeUpperShadowClean(bars, WCMI_CONFIG))).toBe(true);
});

it('computeUpperShadowClean: saturated shadow clips penalty to 1 per component', () => {
  // very large upper shadow relative to body+range
  const bars = bar(100, 100, 200, 99, 101);
  const score = computeUpperShadowClean(bars, WCMI_CONFIG);
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThan(1);
});
