import { computeRecentStrength } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/recent-strength.js';
import type { WcmiConfig } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/types.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/config.js';
import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';

function bar(o: number, h: number, l: number, c: number): BarLike {
  return {
    trade_date: '2026-01-01',
    open_qfq: o,
    high_qfq: h,
    low_qfq: l,
    close_qfq: c,
    volume: 1,
    turnover: 1,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
  };
}

const CFG: WcmiConfig = WCMI_CONFIG;

describe('computeRecentStrength', () => {
  it('returns 1 when fewer than 2 bars', () => {
    expect(computeRecentStrength([], CFG)).toBe(1);
    expect(computeRecentStrength([bar(10, 11, 9, 10)], CFG)).toBe(1);
  });

  it('rewards a straight uptrend with last bar at the high', () => {
    const bars: BarLike[] = [];
    for (let i = 0; i < 20; i += 1) bars.push(bar(10 + i, 10 + i + 1, 10 + i - 0.1, 10 + i + 0.8));
    const v = computeRecentStrength(bars, CFG);
    expect(v).toBeGreaterThan(0.85);
  });

  it('zeroes the yin-run component on a 5-bar consecutive close<open streak', () => {
    // First 15 bars: yang. Last 5 bars: each closes below open (yin).
    const bars: BarLike[] = [];
    for (let i = 0; i < 15; i += 1) bars.push(bar(10, 11, 9.5, 10.5));
    for (let i = 0; i < 5; i += 1) bars.push(bar(10.5, 10.7, 9.5, 9.8));
    const v = computeRecentStrength(bars, CFG);
    // recent_ret slightly negative → ~0.16 retScore, yin run = 5 → 0,
    // pullback ≈ 11% → partial. Composite stays well under 0.2.
    expect(v).toBeLessThan(0.2);
  });

  it('penalises pullback from window high regardless of yin/yang of the last bar', () => {
    const bars: BarLike[] = [];
    for (let i = 0; i < 15; i += 1) bars.push(bar(10, 30, 9, 28)); // window high = 30
    // Then 10 stable bars at price 22 (~27% off the high) — all yang, no yin run.
    for (let i = 0; i < 10; i += 1) bars.push(bar(21.5, 22.2, 21.4, 22));
    const v = computeRecentStrength(bars, CFG);
    expect(v).toBeLessThan(0.5);
  });

  it('respects RECENT_YIN_RUN_CAP override — harsher cap → harsher penalty', () => {
    const bars: BarLike[] = [];
    for (let i = 0; i < 10; i += 1) bars.push(bar(10, 11, 9.5, 10.5));
    for (let i = 0; i < 3; i += 1) bars.push(bar(10.5, 10.6, 9.9, 10));
    const lenient = computeRecentStrength(bars, { ...CFG, RECENT_YIN_RUN_CAP: 6 });
    const harsh = computeRecentStrength(bars, { ...CFG, RECENT_YIN_RUN_CAP: 3 });
    expect(harsh).toBeLessThan(lenient);
  });
});
