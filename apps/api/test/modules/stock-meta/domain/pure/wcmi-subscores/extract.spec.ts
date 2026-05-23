import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { extractWcmiSubscores } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/extract.js';
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

it('extractWcmiSubscores: returns null when bars.length < 30', () => {
  expect(extractWcmiSubscores(makeBars(29, (i) => 100 + i), WCMI_CONFIG)).toBeNull();
});

it('extractWcmiSubscores: returns null for empty input', () => {
  expect(extractWcmiSubscores([], WCMI_CONFIG)).toBeNull();
});

it('extractWcmiSubscores: passesGate=false when r_window <= 0 (declining series)', () => {
  const bars = makeBars(30, (i) => 100 - i);
  const result = extractWcmiSubscores(bars, WCMI_CONFIG);
  expect(result).not.toBeNull();
  expect(result!.passesGate).toBe(false);
});

it('extractWcmiSubscores: all 7 sub-score fields populated for 30-bar series', () => {
  const bars = makeBars(30, (i) => 100 + i);
  const result = extractWcmiSubscores(bars, WCMI_CONFIG)!;
  expect(result).not.toBeNull();
  expect(Number.isFinite(result.rhythm)).toBe(true);
  expect(Number.isFinite(result.maSupport)).toBe(true);
  expect(Number.isFinite(result.upWaveSmoothness)).toBe(true);
  expect(Number.isFinite(result.yangDominance)).toBe(true);
  expect(Number.isFinite(result.upperShadowClean)).toBe(true);
  expect(Number.isFinite(result.stageGain)).toBe(true);
  expect(Number.isFinite(result.crashAvoidance)).toBe(true);
});

it('extractWcmiSubscores: windowLen=30 when 30 <= bars < 90', () => {
  const bars = makeBars(30, (i) => 100 + i);
  const result = extractWcmiSubscores(bars, WCMI_CONFIG)!;
  expect(result.windowLen).toBe(30);
});

it('extractWcmiSubscores: windowLen=90 when bars >= 90 (uses trailing window)', () => {
  const bars = makeBars(120, (i) => 100 + i);
  const result = extractWcmiSubscores(bars, WCMI_CONFIG)!;
  expect(result.windowLen).toBe(90);
});

it('extractWcmiSubscores: passesGate=true for a rising series', () => {
  const bars = makeBars(30, (i) => 100 + i);
  const result = extractWcmiSubscores(bars, WCMI_CONFIG)!;
  expect(result.passesGate).toBe(true);
});
