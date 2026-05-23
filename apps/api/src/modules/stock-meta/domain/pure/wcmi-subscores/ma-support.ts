import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';

/**
 * Cross-period MA-support sub-score.
 *
 * Rewards consistent close-above-ma5/ma10/ma20 ratios with descending
 * weights — the shorter the MA, the stronger the "trend intact" signal.
 * ma60 is intentionally excluded.
 */
export function computeMaSupport(bars: readonly BarLike[], config: WcmiConfig): number {
  let aboveMa5 = 0;
  let nMa5 = 0;
  let aboveMa10 = 0;
  let nMa10 = 0;
  let aboveMa20 = 0;
  let nMa20 = 0;
  for (const bar of bars) {
    const { close_qfq: close, ma5, ma10, ma20 } = bar;
    if (ma5 !== null) {
      nMa5 += 1;
      if (close > ma5) aboveMa5 += 1;
    }
    if (ma10 !== null) {
      nMa10 += 1;
      if (close > ma10) aboveMa10 += 1;
    }
    if (ma20 !== null) {
      nMa20 += 1;
      if (close > ma20) aboveMa20 += 1;
    }
  }
  const aboveMa5Rate = nMa5 > 0 ? aboveMa5 / nMa5 : 0;
  const aboveMa10Rate = nMa10 > 0 ? aboveMa10 / nMa10 : 0;
  const aboveMa20Rate = nMa20 > 0 ? aboveMa20 / nMa20 : 0;
  return (
    config.MA_W_ABOVE_MA5 * aboveMa5Rate +
    config.MA_W_ABOVE_MA10 * aboveMa10Rate +
    config.MA_W_ABOVE_MA20 * aboveMa20Rate
  );
}
