import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { computeMaSupport } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/ma-support.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/types.js';

function makeBar(close: number, ma20: number | null, opts?: {
  ma5?: number | null; ma10?: number | null; ma60?: number | null;
}): BarLike {
  return {
    trade_date: '2026-01-01',
    open_qfq: close,
    high_qfq: close,
    low_qfq: close,
    close_qfq: close,
    volume: 0,
    turnover: 0,
    ma5: opts?.ma5 ?? null,
    ma10: opts?.ma10 ?? null,
    ma20,
    ma60: opts?.ma60 ?? null,
  };
}

it('computeMaSupport: all bars above ma20 → aboveMa20Rate=1', () => {
  const bars = Array.from({ length: 5 }, () => makeBar(110, 100));
  const score = computeMaSupport(bars, WCMI_CONFIG);
  // aboveMa20Rate=1, others null → 0.35*1 = 0.35 baseline
  expect(score).toBeCloseTo(0.35 + 0.15 * Math.min((10 / 100) / 0.15, 1), 5);
});

it('computeMaSupport: all bars below ma20 → aboveMa20Rate=0', () => {
  const bars = Array.from({ length: 5 }, () => makeBar(90, 100));
  const score = computeMaSupport(bars, WCMI_CONFIG);
  // aboveMa20Rate=0, meanDist=-0.1 → clip(-0.1/0.15,-1,1)=-0.667
  expect(score).toBeLessThan(0.35);
});

it('computeMaSupport: full bullish MA alignment all bars → alignmentRate=1', () => {
  const bars = Array.from({ length: 5 }, () =>
    makeBar(110, 90, { ma5: 109, ma10: 105, ma60: 80 }),
  );
  const score = computeMaSupport(bars, WCMI_CONFIG);
  // aligned=1 → 0.3 contribution
  expect(score).toBeGreaterThanOrEqual(0.3);
});

it('computeMaSupport: broken alignment contributes 0 alignment term vs full alignment', () => {
  const alignedBars = Array.from({ length: 5 }, () =>
    makeBar(110, 90, { ma5: 109, ma10: 105, ma60: 80 }),
  );
  const brokenBars = Array.from({ length: 5 }, () =>
    makeBar(110, 90, { ma5: 80, ma10: 105, ma60: 80 }),
  );
  const alignedScore = computeMaSupport(alignedBars, WCMI_CONFIG);
  const brokenScore = computeMaSupport(brokenBars, WCMI_CONFIG);
  expect(alignedScore).toBeGreaterThan(brokenScore);
});

it('computeMaSupport: all-null MA bars → graceful skip (uses zero denominators)', () => {
  const bars = Array.from({ length: 5 }, () => makeBar(100, null));
  const score = computeMaSupport(bars, WCMI_CONFIG);
  // nMa20=0 → rates=0; result is 0
  expect(score).toBe(0);
});

it('computeMaSupport: mean_dist_ma20 clipped at +0.15 (close >> ma20)', () => {
  // close=200, ma20=100 → dist=1.0 but clipped to 0.15 → contribution = 0.15*1
  const bars = Array.from({ length: 3 }, () => makeBar(200, 100));
  const score = computeMaSupport(bars, WCMI_CONFIG);
  const expected = 0.35 * 1 + 0.15 * 1;
  expect(score).toBeCloseTo(expected, 5);
});

it('computeMaSupport: mean_dist_ma20 clipped at -1 (close << ma20)', () => {
  // close=1, ma20=100 → dist=-0.99 → clip(-0.99/0.15,-1,1)=-1
  const bars = Array.from({ length: 3 }, () => makeBar(1, 100));
  const score = computeMaSupport(bars, WCMI_CONFIG);
  const expected = 0.35 * 0 + 0.15 * -1;
  expect(score).toBeCloseTo(expected, 5);
});
