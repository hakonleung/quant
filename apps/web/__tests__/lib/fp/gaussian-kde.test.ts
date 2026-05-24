import { describe, expect, it } from 'vitest';

import { kde, linspace, silvermanBandwidth } from '../../../lib/fp/gaussian-kde.js';

describe('silvermanBandwidth', () => {
  it('returns 0 for an empty sample', () => {
    expect(silvermanBandwidth([])).toBe(0);
  });

  it('returns 0 for n=1', () => {
    expect(silvermanBandwidth([0.5])).toBe(0);
  });

  it('returns 0 when all values are identical', () => {
    expect(silvermanBandwidth([0.1, 0.1, 0.1, 0.1])).toBe(0);
  });

  it('is positive for a well-spread sample', () => {
    const bw = silvermanBandwidth([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(bw).toBeGreaterThan(0);
  });
});

describe('kde', () => {
  it('returns all zeros for empty values', () => {
    expect(kde([], [0, 0.5, 1], 0.1)).toEqual([0, 0, 0]);
  });

  it('returns all zeros when bandwidth is 0', () => {
    expect(kde([0.1, 0.2], [0, 0.5], 0)).toEqual([0, 0]);
  });

  it('produces non-negative densities', () => {
    const xs = linspace(-1, 1, 20);
    const out = kde([-0.5, 0, 0.5], xs, 0.2);
    expect(out.every((v) => v >= 0)).toBe(true);
  });

  it('is symmetric for symmetric input', () => {
    const xs = linspace(-1, 1, 21);
    const out = kde([-0.5, 0, 0.5], xs, 0.2);
    for (let i = 0; i < Math.floor(xs.length / 2); i++) {
      const lhs = out[i] ?? 0;
      const rhs = out[xs.length - 1 - i] ?? 0;
      expect(Math.abs(lhs - rhs)).toBeLessThan(1e-12);
    }
  });

  it('peaks near the sample mode', () => {
    const xs = linspace(-1, 1, 101);
    const out = kde([0], xs, 0.2);
    let maxIdx = 0;
    let maxVal = -Infinity;
    out.forEach((v, i) => {
      if (v > maxVal) {
        maxVal = v;
        maxIdx = i;
      }
    });
    expect(xs[maxIdx]).toBeCloseTo(0, 5);
  });
});

describe('linspace', () => {
  it('returns empty for count=0', () => {
    expect(linspace(0, 1, 0)).toEqual([]);
  });

  it('returns [min] for count=1', () => {
    expect(linspace(0.3, 0.7, 1)).toEqual([0.3]);
  });

  it('returns endpoints inclusive for count>=2', () => {
    const xs = linspace(0, 1, 5);
    expect(xs).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});
