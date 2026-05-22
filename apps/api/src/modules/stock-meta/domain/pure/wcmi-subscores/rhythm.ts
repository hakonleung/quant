import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';
import { clip, pearsonCorr } from './utils.js';

/**
 * Wave-regularity sub-score.
 *
 * Combines a lag-1 autocorrelation match-quality term (centred on
 * `RHYTHM_TARGET`) with a swing-density term measuring local-peak /
 * local-trough counts vs the configured swing period.
 */
export function computeRhythm(bars: readonly BarLike[], config: WcmiConfig): number {
  const n = bars.length;
  if (n < 3) return 0;
  const closes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    if (bar !== undefined) closes.push(bar.close_qfq);
  }
  const returns = computeReturns(closes);
  const autocorr = lag1Autocorr(returns);
  const autocorrScore = -Math.abs(autocorr - config.RHYTHM_TARGET);
  const { peaks, troughs } = countPeaksAndTroughs(closes);
  const swingCount = Math.min(peaks, troughs);
  const expectedSwings = n / config.SWING_PERIOD_BARS;
  const swingDensity = expectedSwings > 0 ? swingCount / expectedSwings : 0;
  return 0.6 * clip(autocorrScore / 0.5, -1, 1) + 0.4 * (clip(swingDensity, 0, 2) - 1);
}

function computeReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined || prev <= 0) continue;
    out.push((cur - prev) / prev);
  }
  return out;
}

function lag1Autocorr(returns: readonly number[]): number {
  if (returns.length < 3) return 0;
  const a = returns.slice(0, returns.length - 1);
  const b = returns.slice(1);
  return pearsonCorr(a, b);
}

function countPeaksAndTroughs(closes: readonly number[]): {
  peaks: number;
  troughs: number;
} {
  let peaks = 0;
  let troughs = 0;
  for (let i = 1; i < closes.length - 1; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const next = closes[i + 1];
    if (prev === undefined || cur === undefined || next === undefined) continue;
    if (cur > prev && cur > next) peaks += 1;
    if (cur < prev && cur < next) troughs += 1;
  }
  return { peaks, troughs };
}
