import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';
import { clip } from './utils.js';

/** Penalise large single-day drops and unrecovered gap-downs. */
export function computeCrashAvoidance(
  bars: readonly BarLike[],
  config: WcmiConfig,
): number {
  if (bars.length < 2) return 1;
  let crashDays = 0;
  let gapDownDays = 0;
  let crashAbsSum = 0;
  for (let i = 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (bar === undefined || prev === undefined) continue;
    const prevClose = prev.close_qfq;
    if (prevClose <= 0) continue;
    const change = ((bar.close_qfq - prevClose) / prevClose) * 100;
    const gap = ((bar.open_qfq - prevClose) / prevClose) * 100;
    const yang = bar.close_qfq > bar.open_qfq;
    if (change < -config.CRASH_DAY_THR) {
      crashDays += 1;
      crashAbsSum += Math.abs(change);
    }
    if (gap < config.GAP_DOWN_THR && !yang) gapDownDays += 1;
  }
  const crashSeverity = crashDays > 0 ? crashAbsSum / crashDays : 0;
  const excessSeverity = Math.max(0, crashSeverity - config.CRASH_DAY_THR);
  return (
    1 -
    0.5 * clip(crashDays / config.CRASH_COUNT_CAP, 0, 1) -
    0.3 * clip(excessSeverity / config.CRASH_SEVERITY_SPAN_PCT, 0, 1) -
    0.2 * clip(gapDownDays / config.GAP_DOWN_CAP, 0, 1)
  );
}
