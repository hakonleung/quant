import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { computeRhythm } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/rhythm.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/types.js';

function makeBars(n: number, closeFn: (i: number) => number): BarLike[] {
  return Array.from({ length: n }, (_, i) => {
    const c = closeFn(i);
    return {
      trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
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
    };
  });
}

it('computeRhythm: fewer than 3 bars returns 0', () => {
  expect(computeRhythm(makeBars(2, (i) => 10 + i), WCMI_CONFIG)).toBe(0);
});

it('computeRhythm: clear alternating swing pattern produces a finite score', () => {
  // sawtooth: up-down-up-down — generates real peaks and troughs
  const bars = makeBars(30, (i) => 100 + (i % 2 === 0 ? 1 : -1) * 2);
  const score = computeRhythm(bars, WCMI_CONFIG);
  expect(Number.isFinite(score)).toBe(true);
});

it('computeRhythm: constant prices yield low autocorr_score (autocorr=0)', () => {
  // constant → zero-variance returns → pearsonCorr returns 0 → autocorrScore = -|0 - 0.15| = -0.15
  const bars = makeBars(30, () => 100);
  const score = computeRhythm(bars, WCMI_CONFIG);
  // autocorr=0, swingDensity=0 → 0.6*(clip(-0.15/0.5,-1,1)) + 0.4*(0-1)
  expect(score).toBeLessThan(0);
});

it('computeRhythm: monotonically increasing prices yield low swing_density', () => {
  // all-up means no local peaks/troughs at all → swingDensity=0
  const bars = makeBars(30, (i) => 100 + i);
  const score = computeRhythm(bars, WCMI_CONFIG);
  // swingDensity=0 → 0.4*(0-1) = -0.4 plus autocorr component
  expect(score).toBeLessThan(0);
});

it('computeRhythm: minimum N=30 window is accepted (returns finite value)', () => {
  const bars = makeBars(30, (i) => 100 + (i % 3 === 0 ? 2 : i % 3 === 1 ? -1 : 0));
  expect(Number.isFinite(computeRhythm(bars, WCMI_CONFIG))).toBe(true);
});
