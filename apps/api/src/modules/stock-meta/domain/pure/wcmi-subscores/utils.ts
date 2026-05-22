/** Pure numeric helpers shared across the WCMI v2 sub-score modules. */

export function clip(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Average-rank percentile of `value` against an ascending-sorted array.
 *
 * Returns the mean of the lower and upper rank fractions, so ties are
 * split symmetrically. With `sorted.length === 0` returns `0.5`; with a
 * single element returns `0.5` regardless of `value`.
 */
export function percentileNorm(sorted: readonly number[], value: number): number {
  const n = sorted.length;
  if (n === 0) return 0.5;
  if (n === 1) return 0.5;
  const lower = lowerBound(sorted, value);
  const upper = upperBound(sorted, value);
  return (lower + upper) / 2 / n;
}

/** First index `i` such that `sorted[i] >= value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const probe = sorted[mid];
    if (probe === undefined || probe < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index `i` such that `sorted[i] > value`. */
function upperBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const probe = sorted[mid];
    if (probe === undefined || probe <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Pearson correlation; returns 0 when either variance is 0 or N < 2. */
export function pearsonCorr(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i] ?? 0;
    sumY += ys[i] ?? 0;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

/** OLS coefficient of determination of `ys` on `xs`. Returns 0 when ys
 *  has zero variance (no signal to explain). */
export function olsR2(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i] ?? 0;
    sumY += ys[i] ?? 0;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (syy === 0) return 0;
  if (sxx === 0) return 0;
  const r = sxy / Math.sqrt(sxx * syy);
  return r * r;
}
