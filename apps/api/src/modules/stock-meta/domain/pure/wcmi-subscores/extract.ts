import { computeCrashAvoidance } from './crash-avoidance.js';
import { computeMaSupport } from './ma-support.js';
import { computeRhythm } from './rhythm.js';
import { computeStageGain } from './stage-gain.js';
import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig, WcmiSubscores } from './types.js';
import { computeUpperShadowClean } from './upper-shadow.js';
import { computeUpWaveSmoothness } from './up-wave.js';
import { computeYangDominance } from './yang-dominance.js';

/** Minimum history required to score a code; below this the code is
 *  excluded from rank tables. */
const MIN_BARS = 30;

/**
 * Compute the seven raw sub-scores for a single code over the trailing
 * `config.WINDOW` bars (or all bars when history is between `MIN_BARS`
 * and `config.WINDOW`).
 *
 * Returns `null` when `bars.length < MIN_BARS`.
 */
export function extractWcmiSubscores(
  bars: readonly BarLike[],
  config: WcmiConfig,
): WcmiSubscores | null {
  if (bars.length < MIN_BARS) return null;
  const window = bars.length > config.WINDOW ? bars.slice(-config.WINDOW) : bars.slice();
  const rhythm = computeRhythm(window, config);
  const maSupport = computeMaSupport(window, config);
  const upWaveSmoothness = computeUpWaveSmoothness(window, config);
  const yangDominance = computeYangDominance(window, config);
  const upperShadowClean = computeUpperShadowClean(window, config);
  const stage = computeStageGain(window, config);
  const crashAvoidance = computeCrashAvoidance(window, config);
  return {
    rhythm,
    maSupport,
    upWaveSmoothness,
    yangDominance,
    upperShadowClean,
    stageGain: stage.value,
    crashAvoidance,
    windowLen: window.length,
    passesGate: stage.rWindow > 0,
  };
}
