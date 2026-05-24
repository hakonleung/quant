import { describe, expect, it } from 'vitest';

import { buildHistogram, pickBinCount } from '../../../lib/fp/return-histogram.js';

describe('pickBinCount', () => {
  it('returns the floor when the sample is empty', () => {
    expect(pickBinCount([])).toBe(12);
  });

  it('returns the floor when n=1', () => {
    expect(pickBinCount([0.1])).toBe(12);
  });

  it('returns the floor when all values are identical', () => {
    expect(pickBinCount(new Array(50).fill(0.05))).toBe(12);
  });

  it('clamps to the ceiling for heavy-tailed data with tight IQR', () => {
    // Most mass in a narrow IQR, but a few extreme outliers blow up
    // the range so FD's range/binWidth ratio exceeds the ceiling.
    const xs: number[] = [];
    for (let i = 0; i < 200; i++) xs.push(i / 10_000);
    xs.push(-100, 100);
    expect(pickBinCount(xs)).toBe(40);
  });

  it('returns a value in [12, 40] for typical input', () => {
    const xs = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 0.1);
    const n = pickBinCount(xs);
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBeLessThanOrEqual(40);
  });
});

describe('buildHistogram', () => {
  it('returns empty result for empty input', () => {
    expect(buildHistogram([], 12, -1, 1)).toEqual({ bins: [], maxCount: 0 });
  });

  it('returns empty result for a zero-width domain', () => {
    expect(buildHistogram([0.1, 0.2], 12, 0.5, 0.5)).toEqual({ bins: [], maxCount: 0 });
  });

  it('returns empty result when binCount is zero', () => {
    expect(buildHistogram([0.1], 0, 0, 1)).toEqual({ bins: [], maxCount: 0 });
  });

  it('sum of counts equals number of in-range values', () => {
    const values = [-0.5, -0.1, 0, 0.1, 0.4, 0.49];
    const { bins } = buildHistogram(values, 10, -0.5, 0.5);
    const sum = bins.reduce((s, b) => s + b.count, 0);
    expect(sum).toBe(values.length);
  });

  it('skips values outside the domain', () => {
    const { bins } = buildHistogram([-2, 0, 2], 4, -1, 1);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it('places the right-edge value in the last bin', () => {
    const { bins } = buildHistogram([1], 4, 0, 1);
    expect(bins[bins.length - 1]?.count).toBe(1);
  });

  it('reports the maxCount across bins', () => {
    const values = [0, 0, 0, 0.5, 0.9];
    const { maxCount } = buildHistogram(values, 4, 0, 1);
    expect(maxCount).toBe(3);
  });

  it('produces evenly-spaced bins covering the domain', () => {
    const { bins } = buildHistogram([0], 4, 0, 1);
    expect(bins.map((b) => b.x0)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(bins.map((b) => b.x1)).toEqual([0.25, 0.5, 0.75, 1]);
  });
});
