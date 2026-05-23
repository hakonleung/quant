import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { computeYangDominance } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/yang-dominance.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/config.js';

function bar(open: number, close: number): BarLike {
  return {
    trade_date: '2026-01-01',
    open_qfq: open,
    high_qfq: Math.max(open, close),
    low_qfq: Math.min(open, close),
    close_qfq: close,
    volume: 0,
    turnover: 0,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
  };
}

it('computeYangDominance: empty bars returns 0', () => {
  expect(computeYangDominance([], WCMI_CONFIG)).toBe(0);
});

it('computeYangDominance: all-yang bars returns 1', () => {
  const bars = Array.from({ length: 10 }, () => bar(100, 110));
  expect(computeYangDominance(bars, WCMI_CONFIG)).toBe(1);
});

it('computeYangDominance: no-yang (all yin) bars returns 0', () => {
  const bars = Array.from({ length: 10 }, () => bar(110, 100));
  expect(computeYangDominance(bars, WCMI_CONFIG)).toBe(0);
});

it('computeYangDominance: mixed 3 yang / 7 yin returns 0.3', () => {
  const bars = [
    ...Array.from({ length: 3 }, () => bar(100, 110)),
    ...Array.from({ length: 7 }, () => bar(110, 100)),
  ];
  expect(computeYangDominance(bars, WCMI_CONFIG)).toBeCloseTo(0.3, 10);
});

it('computeYangDominance: doji bar (close === open) is not yang', () => {
  const bars = [bar(100, 100)];
  expect(computeYangDominance(bars, WCMI_CONFIG)).toBe(0);
});
