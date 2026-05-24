/**
 * Pure histogram helpers for the BT.EVAL return-distribution charts.
 *
 * Inputs are arrays of returns (fractions, e.g. 0.12 = +12%). Output is a
 * series of bins suitable for direct SVG rectangle mapping. No DOM /
 * randomness / clock dependencies.
 */

export interface HistogramBin {
  readonly x0: number;
  readonly x1: number;
  readonly count: number;
}

export interface Histogram {
  readonly bins: readonly HistogramBin[];
  readonly maxCount: number;
}

const MIN_BIN = 12;
const MAX_BIN = 40;

/**
 * Choose a bin count for the supplied data.
 *
 * Prefers Freedman–Diaconis (robust to outliers); falls back to sqrt(n)
 * when the IQR collapses. Always clamped into [MIN_BIN, MAX_BIN].
 */
export function pickBinCount(values: readonly number[]): number {
  const n = values.length;
  if (n <= 1) return MIN_BIN;
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const range = max - min;
  if (range <= 0) return MIN_BIN;
  let raw: number;
  if (iqr > 0) {
    const binWidth = (2 * iqr) / Math.cbrt(n);
    raw = binWidth > 0 ? Math.ceil(range / binWidth) : Math.ceil(Math.sqrt(n));
  } else {
    raw = Math.ceil(Math.sqrt(n));
  }
  return Math.max(MIN_BIN, Math.min(MAX_BIN, raw));
}

/**
 * Build an equal-width histogram over `[domainMin, domainMax]`. Returns
 * `{ bins: [], maxCount: 0 }` for empty input or a zero-width domain —
 * callers render a "sample too small" hint in that case.
 */
export function buildHistogram(
  values: readonly number[],
  binCount: number,
  domainMin: number,
  domainMax: number,
): Histogram {
  if (values.length === 0 || binCount <= 0 || !(domainMax > domainMin)) {
    return { bins: [], maxCount: 0 };
  }
  const width = (domainMax - domainMin) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const v of values) {
    if (v < domainMin || v > domainMax) continue;
    let idx = Math.floor((v - domainMin) / width);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const bins: HistogramBin[] = counts.map((count, i) => ({
    x0: domainMin + i * width,
    x1: domainMin + (i + 1) * width,
    count,
  }));
  const maxCount = counts.reduce((m, c) => (c > m ? c : m), 0);
  return { bins, maxCount };
}

function quantile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] ?? 0;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (pos - lo);
}
