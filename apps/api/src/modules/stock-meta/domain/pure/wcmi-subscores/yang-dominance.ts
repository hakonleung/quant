import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';

/** Fraction of bars that are yang (close > open) within the window. */
export function computeYangDominance(
  bars: readonly BarLike[],
  config: WcmiConfig,
): number {
  if (bars.length === 0) return 0;
  let yang = 0;
  for (const bar of bars) {
    if (bar.close_qfq > bar.open_qfq) yang += 1;
  }
  void config;
  return yang / bars.length;
}
