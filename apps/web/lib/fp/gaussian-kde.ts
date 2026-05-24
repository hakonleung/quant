/**
 * Gaussian kernel-density estimation for the BT.EVAL return charts.
 *
 * Renderer-agnostic: callers pass the sample points and the x positions
 * at which to evaluate the density (typically 80 equally-spaced xs
 * spanning the histogram domain). No DOM / randomness / clock deps.
 */

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * Silverman's rule-of-thumb bandwidth: `1.06 * sigma * n^(-1/5)`.
 *
 * Returns 0 when the sample has fewer than 2 points or zero variance —
 * the caller should skip KDE in that case (no smoothing is meaningful).
 */
export function silvermanBandwidth(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  const std = Math.sqrt(sq / (n - 1));
  if (std <= 0) return 0;
  return 1.06 * std * Math.pow(n, -1 / 5);
}

/**
 * Evaluate a Gaussian KDE at each x in `xs`. Returns one density per x
 * (non-negative, integrates to ~1 over the real line). Empty / zero-bw
 * inputs yield an all-zero array — the caller decides whether to draw.
 */
export function kde(
  values: readonly number[],
  xs: readonly number[],
  bandwidth: number,
): number[] {
  const n = values.length;
  const out = new Array<number>(xs.length).fill(0);
  if (n === 0 || bandwidth <= 0) return out;
  const norm = 1 / (n * bandwidth * SQRT_2PI);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] ?? 0;
    let acc = 0;
    for (const v of values) {
      const u = (x - v) / bandwidth;
      acc += Math.exp(-0.5 * u * u);
    }
    out[i] = acc * norm;
  }
  return out;
}

/** Generate `count` equally-spaced xs across `[min, max]` (inclusive). */
export function linspace(min: number, max: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [min];
  const step = (max - min) / (count - 1);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = min + step * i;
  return out;
}
