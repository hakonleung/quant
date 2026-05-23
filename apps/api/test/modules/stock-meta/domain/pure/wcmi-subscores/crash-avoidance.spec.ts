import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { computeCrashAvoidance } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/crash-avoidance.js';
import { WCMI_CONFIG } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/config.js';

function makeBar(prevClose: number, open: number, close: number): BarLike[] {
  const prev: BarLike = {
    trade_date: '2025-12-31',
    open_qfq: prevClose, high_qfq: prevClose, low_qfq: prevClose, close_qfq: prevClose,
    volume: 0, turnover: 0, ma5: null, ma10: null, ma20: null, ma60: null,
  };
  const cur: BarLike = {
    trade_date: '2026-01-01',
    open_qfq: open,
    high_qfq: Math.max(open, close),
    low_qfq: Math.min(open, close),
    close_qfq: close,
    volume: 0, turnover: 0, ma5: null, ma10: null, ma20: null, ma60: null,
  };
  return [prev, cur];
}

function makeBars(_n: number, closeSeq: number[]): BarLike[] {
  return closeSeq.map((c, i) => ({
    trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open_qfq: c,
    high_qfq: c,
    low_qfq: c,
    close_qfq: c,
    volume: 0, turnover: 0, ma5: null, ma10: null, ma20: null, ma60: null,
  }));
}

it('computeCrashAvoidance: fewer than 2 bars returns 1', () => {
  const singleBar: BarLike = {
    trade_date: '2026-01-01',
    open_qfq: 100, high_qfq: 100, low_qfq: 100, close_qfq: 100,
    volume: 0, turnover: 0, ma5: null, ma10: null, ma20: null, ma60: null,
  };
  expect(computeCrashAvoidance([singleBar], WCMI_CONFIG)).toBe(1);
});

it('computeCrashAvoidance: zero crashes → 1.0', () => {
  // flat bars: no change > CRASH_DAY_THR=7%
  const bars = makeBars(10, Array.from({ length: 11 }, () => 100));
  expect(computeCrashAvoidance(bars, WCMI_CONFIG)).toBe(1);
});

it('computeCrashAvoidance: multiple crashes capped by CRASH_COUNT_CAP', () => {
  // CRASH_COUNT_CAP=4: 4 crash days should saturate the crash term to 0.5
  const closes: number[] = [100];
  for (let i = 0; i < 8; i += 1) {
    closes.push(i % 2 === 0 ? closes.at(-1)! * 0.9 : closes.at(-1)! * 1.05);
  }
  const bars = makeBars(closes.length, closes);
  const score = computeCrashAvoidance(bars, WCMI_CONFIG);
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThan(1);
});

it('computeCrashAvoidance: gap-down without recovery (yin) is penalised', () => {
  // gap down > GAP_DOWN_THR=2%, close < open (yin)
  const bars = makeBar(100, 95, 93); // gap=-5%, yin
  const score = computeCrashAvoidance(bars, WCMI_CONFIG);
  // gapDownDays=1 → -0.2*clip(1/6,0,1)
  expect(score).toBeLessThan(1);
});

it('computeCrashAvoidance: gap-down but yang (recovered) is NOT penalised for gap', () => {
  // gap down > GAP_DOWN_THR but close > open (yang): gapDown counter not incremented
  const bars = makeBar(100, 95, 98); // gap=-5%, yang
  const scorePure = computeCrashAvoidance(bars, WCMI_CONFIG);
  // no gapDownDay recorded; change=((98-100)/100)*100=-2% which is < CRASH_DAY_THR=7
  expect(scorePure).toBe(1);
});

it('computeCrashAvoidance: crash day excess severity clipped by SEVERITY_SPAN_PCT', () => {
  // one crash day with change=-20% → excess=20-7=13 > SEVERITY_SPAN_PCT=5 → clipped to 1
  const bars = makeBar(100, 100, 79);
  const score = computeCrashAvoidance(bars, WCMI_CONFIG);
  // crashDays=1, severity=21, excess=21-7=14 → clipped → -0.5*(1/4)-0.3*1 = -0.425
  expect(score).toBeCloseTo(1 - 0.5 * (1 / 4) - 0.3 * 1, 3);
});
