import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';
import { clip } from './utils.js';

/**
 * Returns a `[0, 1]` cleanliness score where 1 = no upper-shadow
 * rejection and 0 = saturated long shadows on every bar. Yang bars are
 * weighted 1.5x because failed upthrust on a yang candle is the
 * stronger negative signal.
 *
 * The first bar (no prev close available) is skipped.
 */
export function computeUpperShadowClean(
  bars: readonly BarLike[],
  config: WcmiConfig,
): number {
  if (bars.length < 2) return 1;
  let weightedPenalty = 0;
  let totalWeight = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (bar === undefined || prev === undefined) continue;
    const prevClose = prev.close_qfq;
    if (prevClose <= 0) continue;
    const open = bar.open_qfq;
    const close = bar.close_qfq;
    const high = bar.high_qfq;
    const low = bar.low_qfq;
    const upperShadow = (Math.max(high - Math.max(open, close), 0) / prevClose) * 100;
    const body = (Math.abs(close - open) / prevClose) * 100;
    const range = ((high - low) / prevClose) * 100;
    const shadowBodyRatio = upperShadow / Math.max(body, config.SHADOW_MIN_DIVISOR_PCT);
    const shadowRangeRatio = upperShadow / Math.max(range, config.SHADOW_MIN_DIVISOR_PCT);
    const penalty =
      config.SHADOW_W_BODY * clip(shadowBodyRatio / config.SHADOW_BODY_THR, 0, 1) +
      config.SHADOW_W_RANGE * clip(shadowRangeRatio / config.SHADOW_RANGE_THR, 0, 1);
    const weight = close > open ? config.SHADOW_YANG_WEIGHT : config.SHADOW_YIN_WEIGHT;
    weightedPenalty += penalty * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 1;
  return 1 - weightedPenalty / totalWeight;
}
