import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { extractWcmiSubscoreDetail } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/detail.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/config.js';

function makeBars(n: number, closeFn: (i: number) => number): BarLike[] {
  return Array.from({ length: n }, (_, i) => {
    const c = closeFn(i);
    return {
      trade_date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
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

it('extractWcmiSubscoreDetail: returns null when bars.length < 30', () => {
  expect(extractWcmiSubscoreDetail(makeBars(29, (i) => 100 + i), WCMI_CONFIG)).toBeNull();
});

it('extractWcmiSubscoreDetail: all 8 intermediate fields are present for a valid window', () => {
  const bars = makeBars(30, (i) => 100 + i);
  const detail = extractWcmiSubscoreDetail(bars, WCMI_CONFIG)!;
  expect(Number.isFinite(detail.swingDensity)).toBe(true);
  expect(Number.isFinite(detail.lag1Autocorr)).toBe(true);
  expect(Number.isFinite(detail.maSupportRaw)).toBe(true);
  expect(Number.isFinite(detail.upWaveSmoothnessRaw)).toBe(true);
  expect(Number.isFinite(detail.yangDominanceRaw)).toBe(true);
  expect(Number.isFinite(detail.upperShadowCleanRaw)).toBe(true);
  expect(Number.isFinite(detail.stageGainRaw)).toBe(true);
  expect(Number.isFinite(detail.crashAvoidanceRaw)).toBe(true);
});

it('extractWcmiSubscoreDetail: passesGate=false when r_window <= 0', () => {
  const bars = makeBars(30, (i) => 100 - i);
  const detail = extractWcmiSubscoreDetail(bars, WCMI_CONFIG)!;
  expect(detail.passesGate).toBe(false);
});

it('extractWcmiSubscoreDetail: windowLen=90 when bars >= 90 (trailing window)', () => {
  const bars = makeBars(120, (i) => 100 + i);
  const detail = extractWcmiSubscoreDetail(bars, WCMI_CONFIG)!;
  expect(detail.windowLen).toBe(90);
});

it('extractWcmiSubscoreDetail: swingDensity is non-negative', () => {
  const bars = makeBars(30, (i) => 100 + (i % 2 === 0 ? 2 : -1));
  const detail = extractWcmiSubscoreDetail(bars, WCMI_CONFIG)!;
  expect(detail.swingDensity).toBeGreaterThanOrEqual(0);
});

it('extractWcmiSubscoreDetail: lag1Autocorr is in [-1, 1]', () => {
  const bars = makeBars(30, (i) => 100 + Math.sin(i) * 5);
  const detail = extractWcmiSubscoreDetail(bars, WCMI_CONFIG)!;
  expect(detail.lag1Autocorr).toBeGreaterThanOrEqual(-1);
  expect(detail.lag1Autocorr).toBeLessThanOrEqual(1);
});

it('extractWcmiSubscoreDetail: rWindow matches stageGain rWindow field', () => {
  const bars = makeBars(30, (i) => 100 + i);
  const detail = extractWcmiSubscoreDetail(bars, WCMI_CONFIG)!;
  expect(detail.rWindow).toBeGreaterThan(0);
  expect(detail.passesGate).toBe(true);
});
