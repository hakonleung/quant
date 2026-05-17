import { describe, expect, it } from 'vitest';

import { computeBoxLayout, type BoxStat } from './boxplot-geometry.js';

const opts = {
  width: 400,
  height: 200,
  padding: [40, 20, 20, 30] as const,
  tickHint: 5,
};

function statAt(label: string, base: number): BoxStat {
  return {
    label,
    n: 100,
    mean: base,
    median: base,
    p05: base - 0.05,
    p25: base - 0.02,
    p75: base + 0.02,
    p95: base + 0.05,
  };
}

describe('computeBoxLayout', () => {
  it('returns one column per input row in order', () => {
    const layout = computeBoxLayout(
      [statAt('5d', 0.01), statAt('10d', 0.02), statAt('20d', 0.03)],
      opts,
    );
    expect(layout.columns.map((c) => c.label)).toEqual(['5d', '10d', '20d']);
  });

  it('places medians monotonically when input is monotonic', () => {
    // Bigger return → higher up the chart → smaller Y in SVG space.
    const layout = computeBoxLayout([statAt('a', 0), statAt('b', 0.05)], opts);
    expect(layout.columns[1]!.yMedian).toBeLessThan(layout.columns[0]!.yMedian);
  });

  it('keeps box (p25..p75) inside whiskers (p05..p95)', () => {
    const layout = computeBoxLayout([statAt('a', 0.02)], opts);
    const c = layout.columns[0]!;
    // Lower numerical Y == higher on the chart.
    expect(c.yP05).toBeGreaterThan(c.yP25);
    expect(c.yP25).toBeGreaterThan(c.yP75);
    expect(c.yP75).toBeGreaterThan(c.yP95);
  });

  it('includes zero in the domain even when all returns are positive', () => {
    const layout = computeBoxLayout([statAt('a', 0.05)], opts);
    // yZero must fall inside the plot area (between top and bottom).
    expect(layout.yZero).toBeGreaterThanOrEqual(layout.plotTop);
    expect(layout.yZero).toBeLessThanOrEqual(layout.plotBottom);
  });

  it('produces an empty column for n=0 instead of dropping it', () => {
    const empty: BoxStat = {
      label: '90d',
      n: 0,
      mean: 0,
      median: 0,
      p05: 0,
      p25: 0,
      p75: 0,
      p95: 0,
    };
    const layout = computeBoxLayout([statAt('5d', 0.01), empty], opts);
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[1]!.n).toBe(0);
  });

  it('falls back to a placeholder axis when input is entirely empty', () => {
    const layout = computeBoxLayout([], opts);
    expect(layout.columns).toEqual([]);
    expect(layout.yTicks.length).toBeGreaterThan(0);
  });

  it('emits at least two ticks covering both signs of the data range', () => {
    const layout = computeBoxLayout([statAt('a', 0.02), statAt('b', -0.03)], opts);
    expect(layout.yTicks.length).toBeGreaterThanOrEqual(2);
    const values = layout.yTicks.map((t) => t.value);
    expect(Math.min(...values)).toBeLessThanOrEqual(0);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(0);
  });
});
