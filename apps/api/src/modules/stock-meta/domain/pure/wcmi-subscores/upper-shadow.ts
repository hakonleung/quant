import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';

/**
 * Returns a `[0, 1]` cleanliness score where 1 = no long upper shadows
 * and 0 = every bar has a long upper shadow (`upperShadow >=
 * SHADOW_LONG_PCT` of prev close). Yang bars are weighted more because
 * failed upthrust on a yang candle is the stronger negative signal.
 *
 * The first bar (no prev close available) is skipped.
 */
export function computeUpperShadowClean(bars: readonly BarLike[], config: WcmiConfig): number {
  if (bars.length < 2) return 1;
  const window =
    bars.length > config.SHADOW_WINDOW ? bars.slice(-config.SHADOW_WINDOW) : bars;
  let weightedPenalty = 0;
  let totalWeight = 0;
  for (let i = 1; i < window.length; i += 1) {
    const bar = window[i];
    const prev = window[i - 1];
    if (bar === undefined || prev === undefined) continue;
    const prevClose = prev.close_qfq;
    if (prevClose <= 0) continue;
    const open = bar.open_qfq;
    const close = bar.close_qfq;
    const high = bar.high_qfq;
    const upperShadow = (Math.max(high - Math.max(open, close), 0) / prevClose) * 100;
    const penalty = upperShadow >= config.SHADOW_LONG_PCT ? 1 : 0;
    const weight = close > open ? config.SHADOW_YANG_WEIGHT : config.SHADOW_YIN_WEIGHT;
    weightedPenalty += penalty * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 1;
  return 1 - weightedPenalty / totalWeight;
}
