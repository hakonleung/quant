import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';
import { clip } from './utils.js';

/**
 * Cross-period MA-support sub-score.
 *
 * Rewards consistent close-above-ma20/ma60 ratios, the bullish
 * `ma5>ma10>ma20>ma60` alignment frequency, and how far above ma20 the
 * close sits on average.
 */
export function computeMaSupport(bars: readonly BarLike[], config: WcmiConfig): number {
  let aboveMa20 = 0;
  let nMa20 = 0;
  let aboveMa60 = 0;
  let nMa60 = 0;
  let aligned = 0;
  let nAll4 = 0;
  let distSum = 0;
  let nDist = 0;
  for (const bar of bars) {
    const { close_qfq: close, ma5, ma10, ma20, ma60 } = bar;
    if (ma20 !== null) {
      nMa20 += 1;
      if (close > ma20) aboveMa20 += 1;
      if (ma20 > 0) {
        distSum += (close - ma20) / ma20;
        nDist += 1;
      }
    }
    if (ma60 !== null) {
      nMa60 += 1;
      if (close > ma60) aboveMa60 += 1;
    }
    if (ma5 !== null && ma10 !== null && ma20 !== null && ma60 !== null) {
      nAll4 += 1;
      if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) aligned += 1;
    }
  }
  const aboveMa20Rate = nMa20 > 0 ? aboveMa20 / nMa20 : 0;
  const aboveMa60Rate = nMa60 > 0 ? aboveMa60 / nMa60 : 0;
  const alignmentRate = nAll4 > 0 ? aligned / nAll4 : 0;
  const meanDistMa20 = nDist > 0 ? distSum / nDist : 0;
  return (
    config.MA_W_ABOVE_MA20 * aboveMa20Rate +
    config.MA_W_ABOVE_MA60 * aboveMa60Rate +
    config.MA_W_ALIGNMENT * alignmentRate +
    config.MA_W_MEAN_DIST * clip(meanDistMa20 / config.MA20_DIST_CAP, -1, 1)
  );
}
