import { clip, olsR2, pearsonCorr, percentileNorm } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/utils.js';

// ---- percentileNorm ----

it('percentileNorm: empty sorted array returns 0.5', () => {
  expect(percentileNorm([], 42)).toBe(0.5);
});

it('percentileNorm: single-element array returns 0.5 regardless of value', () => {
  expect(percentileNorm([5], 100)).toBe(0.5);
});

it('percentileNorm: monotone ordering is preserved', () => {
  const sorted = [1, 2, 3, 4, 5];
  const p1 = percentileNorm(sorted, 1);
  const p3 = percentileNorm(sorted, 3);
  const p5 = percentileNorm(sorted, 5);
  expect(p1).toBeLessThan(p3);
  expect(p3).toBeLessThan(p5);
});

it('percentileNorm: ties receive average rank (symmetric split)', () => {
  const sorted = [1, 2, 2, 3];
  const pTie = percentileNorm(sorted, 2);
  expect(pTie).toBeCloseTo((1 + 3) / 2 / 4, 10);
});

it('percentileNorm: value below min returns 0', () => {
  expect(percentileNorm([10, 20, 30], 0)).toBe(0);
});

it('percentileNorm: value above max returns 1', () => {
  expect(percentileNorm([10, 20, 30], 99)).toBe(1);
});

// ---- clip ----

it('clip: value below lo returns lo', () => {
  expect(clip(-5, 0, 1)).toBe(0);
});

it('clip: value above hi returns hi', () => {
  expect(clip(5, 0, 1)).toBe(1);
});

it('clip: value within range passes through', () => {
  expect(clip(0.5, 0, 1)).toBe(0.5);
});

// ---- pearsonCorr ----

it('pearsonCorr: zero-variance xs returns 0', () => {
  expect(pearsonCorr([1, 1, 1], [1, 2, 3])).toBe(0);
});

it('pearsonCorr: zero-variance ys returns 0', () => {
  expect(pearsonCorr([1, 2, 3], [2, 2, 2])).toBe(0);
});

it('pearsonCorr: perfect positive correlation returns 1', () => {
  expect(pearsonCorr([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
});

it('pearsonCorr: perfect negative correlation returns -1', () => {
  expect(pearsonCorr([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
});

it('pearsonCorr: fewer than 2 paired elements returns 0', () => {
  expect(pearsonCorr([1], [1])).toBe(0);
  expect(pearsonCorr([], [])).toBe(0);
});

// ---- olsR2 ----

it('olsR2: constant ys (zero variance) returns 0', () => {
  expect(olsR2([1, 2, 3], [5, 5, 5])).toBe(0);
});

it('olsR2: perfect linear fit returns 1', () => {
  expect(olsR2([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 10);
});

it('olsR2: fewer than 2 elements returns 0', () => {
  expect(olsR2([1], [1])).toBe(0);
});
