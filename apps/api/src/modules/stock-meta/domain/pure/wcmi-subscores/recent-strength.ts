/**
 * Short-term wave-quality sub-score. Three components fused into a
 * single raw value ∈ [0, 1]:
 *
 *   1. `recent_ret`  — the trailing `RECENT_WINDOW`-bar qfq return.
 *      Saturates at ±`RECENT_RET_SCALE` (default ±10%).
 *   2. `max_yin_run` — the longest consecutive `close < open` run
 *      inside the recent window. Saturates at `RECENT_YIN_RUN_CAP`
 *      (default 5). This is the dimension the user specifically
 *      requested — a stock that closed red 5 days in a row gets
 *      this component zeroed regardless of the 90-day stage gain.
 *   3. `pullback`    — `(window_high − close[-1]) / window_high`
 *      computed across the full window. Saturates at
 *      `RECENT_PULLBACK_CAP` (default 15%). A stock 20% off its
 *      90-day high has this term zeroed.
 *
 * Component weights (0.40 / 0.35 / 0.25) front-load the recent-return
 * signal but give the yin-run almost the same say. Tweak the cap
 * constants in `WCMI_CONFIG` to change relative harshness without
 * touching this file.
 *
 * Pure — no side effects, no IO; tested via golden + boundary cases
 * in `recent-strength.spec.ts`.
 */

import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';
import { clip } from './utils.js';

const W_RECENT_RET = 0.4;
const W_YIN_RUN = 0.35;
const W_PULLBACK = 0.25;

export function computeRecentStrength(bars: readonly BarLike[], config: WcmiConfig): number {
  const n = bars.length;
  if (n < 2) return 1;
  const k = Math.min(config.RECENT_WINDOW, n - 1);
  if (k < 1) return 1;
  // Recent return — `bars[n - 1 - k]` is the base; `bars[n - 1]` is
  // the latest. `n - 1 - k >= 0` is guaranteed by the `k = min(...)`
  // above.
  const baseClose = bars[n - 1 - k]?.close_qfq ?? 0;
  const latestClose = bars[n - 1]?.close_qfq ?? 0;
  const recentRet = baseClose > 0 ? (latestClose - baseClose) / baseClose : 0;
  const retScore = clip((recentRet + config.RECENT_RET_SCALE) / (2 * config.RECENT_RET_SCALE), 0, 1);

  // Longest consecutive-yin (close < open) run inside the last k bars.
  let maxYinRun = 0;
  let run = 0;
  for (let i = n - k; i < n; i += 1) {
    const bar = bars[i];
    if (bar === undefined) continue;
    if (bar.close_qfq < bar.open_qfq) {
      run += 1;
      if (run > maxYinRun) maxYinRun = run;
    } else {
      run = 0;
    }
  }
  const yinScore = 1 - clip(maxYinRun / config.RECENT_YIN_RUN_CAP, 0, 1);

  // Pullback from window high.
  let windowHigh = 0;
  for (const bar of bars) {
    if (bar.high_qfq > windowHigh) windowHigh = bar.high_qfq;
  }
  const pullback = windowHigh > 0 ? (windowHigh - latestClose) / windowHigh : 0;
  const pullbackScore = 1 - clip(pullback / config.RECENT_PULLBACK_CAP, 0, 1);

  return W_RECENT_RET * retScore + W_YIN_RUN * yinScore + W_PULLBACK * pullbackScore;
}
