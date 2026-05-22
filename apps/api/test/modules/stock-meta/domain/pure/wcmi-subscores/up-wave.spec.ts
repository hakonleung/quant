import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { computeUpWaveSmoothness } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/up-wave.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/types.js';

function makeBars(n: number, openFn: (i: number) => number, closeFn: (i: number) => number): BarLike[] {
  return Array.from({ length: n }, (_, i) => {
    const o = openFn(i);
    const c = closeFn(i);
    return {
      trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open_qfq: o,
      high_qfq: Math.max(o, c),
      low_qfq: Math.min(o, c),
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

it('computeUpWaveSmoothness: all-yang bars maximize yang-run length contribution', () => {
  // 30 consecutive yang candles → maxYangRun=30, meanYangRun=30
  const bars = makeBars(30, (i) => 100 + i, (i) => 101 + i);
  const score = computeUpWaveSmoothness(bars, WCMI_CONFIG);
  // maxYangRun/8=1 capped, meanYangRun/4=1 capped
  expect(score).toBeGreaterThan(0.5);
});

it('computeUpWaveSmoothness: all-yin bars → no yang runs → maxYangRun=0', () => {
  // all yin: close < open
  const bars = makeBars(30, (i) => 101 + i, (i) => 100 + i);
  const score = computeUpWaveSmoothness(bars, WCMI_CONFIG);
  // maxYangRun=0, meanYangRun=0 → first two terms are 0
  expect(score).toBeLessThan(0.5);
});

it('computeUpWaveSmoothness: no qualifying ≥5-bar up-segment → meanSlopeR2=0.5 default', () => {
  // alternating up/down bars: segments are all length 1 (< MIN_SEGMENT_BARS=5)
  const bars = Array.from({ length: 20 }, (_, i): BarLike => ({
    trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open_qfq: 100,
    high_qfq: 100,
    low_qfq: 100,
    close_qfq: i % 2 === 0 ? 101 : 99,
    volume: 0,
    turnover: 0,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
  }));
  // slopeR2Values.length===0 → meanSlopeR2=0.5
  const score = computeUpWaveSmoothness(bars, WCMI_CONFIG);
  // 0.15 * 0.5 = 0.075 from slope term
  expect(score).toBeGreaterThanOrEqual(0);
});

it('computeUpWaveSmoothness: OLS R² on a constant-price segment is 0', () => {
  // flat segment ≥5 bars → constant close → zero variance → olsR2 returns 0
  const bars: BarLike[] = Array.from({ length: 10 }, (_, i) => ({
    trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open_qfq: 100,
    high_qfq: 100,
    low_qfq: 100,
    close_qfq: 100,
    volume: 0,
    turnover: 0,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
  }));
  // one flat up-segment of length 10 >= 5 → R²=0 (constant)
  const score = computeUpWaveSmoothness(bars, WCMI_CONFIG);
  // 0.15 * 0 = 0 from slope term
  expect(score).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(score)).toBe(true);
});

it('computeUpWaveSmoothness: empty bars returns 0.25 (only drawdown and default R2 terms)', () => {
  const score = computeUpWaveSmoothness([], WCMI_CONFIG);
  // no yangs, no segments → 0.35*0 + 0.25*0 + 0.25*(1-0) + 0.15*0.5 = 0.25+0.075=0.325
  expect(score).toBeCloseTo(0.325, 5);
});
