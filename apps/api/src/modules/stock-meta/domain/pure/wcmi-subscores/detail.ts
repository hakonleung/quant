/**
 * Backtest-only helper that exposes the per-sub-score intermediates the
 * self-evaluation script needs to build rule-based labels. Production
 * code paths must keep using {@link extractWcmiSubscores}; the values
 * computed here are not persisted.
 *
 * See `docs/perf/wcmi-redesign.md` § 自评与调优流程.
 */

import type { BarLike } from '../compute-metrics.js';
import { computeCrashAvoidance } from './crash-avoidance.js';
import { computeMaSupport } from './ma-support.js';
import { computeStageGain } from './stage-gain.js';
import type { WcmiConfig } from './types.js';
import { computeUpperShadowClean } from './upper-shadow.js';
import { computeUpWaveSmoothness } from './up-wave.js';
import { computeYangDominance } from './yang-dominance.js';
import { pearsonCorr } from './utils.js';

const MIN_BARS = 30;

export interface WcmiSubscoreDetail {
  readonly swingDensity: number;
  readonly lag1Autocorr: number;
  readonly maSupportRaw: number;
  readonly upWaveSmoothnessRaw: number;
  readonly yangDominanceRaw: number;
  readonly upperShadowCleanRaw: number;
  readonly stageGainRaw: number;
  readonly rWindow: number;
  readonly crashAvoidanceRaw: number;
  readonly windowLen: number;
  readonly passesGate: boolean;
}

export function extractWcmiSubscoreDetail(
  bars: readonly BarLike[],
  config: WcmiConfig,
): WcmiSubscoreDetail | null {
  if (bars.length < MIN_BARS) return null;
  const window = bars.length > config.WINDOW ? bars.slice(-config.WINDOW) : bars.slice();
  const closes = window.map((b) => b.close_qfq);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined || prev <= 0) continue;
    returns.push((cur - prev) / prev);
  }
  const lag1Autocorr =
    returns.length >= 3
      ? pearsonCorr(returns.slice(0, returns.length - 1), returns.slice(1))
      : 0;
  let peaks = 0;
  let troughs = 0;
  for (let i = 1; i < closes.length - 1; i += 1) {
    const p = closes[i - 1];
    const c = closes[i];
    const n = closes[i + 1];
    if (p === undefined || c === undefined || n === undefined) continue;
    if (c > p && c > n) peaks += 1;
    if (c < p && c < n) troughs += 1;
  }
  const swingCount = Math.min(peaks, troughs);
  const expectedSwings = window.length / config.SWING_PERIOD_BARS;
  const swingDensity = expectedSwings > 0 ? swingCount / expectedSwings : 0;
  const stage = computeStageGain(window, config);
  return {
    swingDensity,
    lag1Autocorr,
    maSupportRaw: computeMaSupport(window, config),
    upWaveSmoothnessRaw: computeUpWaveSmoothness(window, config),
    yangDominanceRaw: computeYangDominance(window, config),
    upperShadowCleanRaw: computeUpperShadowClean(window, config),
    stageGainRaw: stage.value,
    rWindow: stage.rWindow,
    crashAvoidanceRaw: computeCrashAvoidance(window, config),
    windowLen: window.length,
    passesGate: stage.rWindow > 0,
  };
}
