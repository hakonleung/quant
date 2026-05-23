import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { computeStageGain } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/stage-gain.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/config.js';

function makeBars(closes: number[]): BarLike[] {
  return closes.map((c, i) => ({
    trade_date: `2026-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
    open_qfq: c,
    high_qfq: c,
    low_qfq: c,
    close_qfq: c,
    volume: 0,
    turnover: 0,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
  }));
}

it('computeStageGain: fewer than 2 bars returns rWindow=0', () => {
  const result = computeStageGain(makeBars([100]), WCMI_CONFIG);
  expect(result.rWindow).toBe(0);
});

it('computeStageGain: rWindow is (endClose - startClose) / startClose * 100', () => {
  const bars = makeBars([100, 110]);
  const result = computeStageGain(bars, WCMI_CONFIG);
  expect(result.rWindow).toBeCloseTo(10, 5);
});

it('computeStageGain: rWindow ≤ 0 for a declining window', () => {
  const bars = makeBars([100, 90]);
  const result = computeStageGain(bars, WCMI_CONFIG);
  expect(result.rWindow).toBeLessThanOrEqual(0);
});

it('computeStageGain: recency_score=1 when max close is at the last bar', () => {
  // monotone up → argMaxClose = n-1, denom = n-1, recencyScore = 1
  const bars = makeBars([100, 101, 102, 103, 104]);
  const result = computeStageGain(bars, WCMI_CONFIG);
  const RECENCY_BIAS = 20;
  // recencyScore=1 → RECENCY_BIAS*1 = 20 contribution
  expect(result.value).toBeGreaterThan(0);
  const rW = ((104 - 100) / 100) * 100;
  const rangeGain = ((104 - 100) / 100) * 100;
  const expected = 0.5 * rW + 0.3 * rangeGain + RECENCY_BIAS * 1;
  expect(result.value).toBeCloseTo(expected, 4);
});

it('computeStageGain: recency_score=0 when max close is at the first bar', () => {
  // monotone down → argMaxClose=0
  const bars = makeBars([104, 103, 102, 101, 100]);
  const result = computeStageGain(bars, WCMI_CONFIG);
  const RECENCY_BIAS = 20;
  expect(result.value).toBeLessThan(RECENCY_BIAS);
});

it('computeStageGain: range_gain uses window low not start close', () => {
  // start=100, low=80 somewhere in middle, end=110
  const bars = makeBars([100, 80, 90, 95, 110]);
  const result = computeStageGain(bars, WCMI_CONFIG);
  const rangeGain = ((110 - 80) / 80) * 100;
  expect(result.value).toBeGreaterThan(0.3 * rangeGain - 1);
});
