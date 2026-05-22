import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';

const RECENCY_BIAS = 20;

export interface StageGainResult {
  readonly value: number;
  readonly rWindow: number;
}

/**
 * Total window return + recency bonus.
 *
 * `rWindow` is exported so the caller can apply the survivor gate
 * (`rWindow <= 0` → null).
 */
export function computeStageGain(bars: readonly BarLike[], config: WcmiConfig): StageGainResult {
  void config;
  if (bars.length < 2) return { value: 0, rWindow: 0 };
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) return { value: 0, rWindow: 0 };
  const startClose = first.close_qfq;
  const endClose = last.close_qfq;
  const rWindow = startClose > 0 ? ((endClose - startClose) / startClose) * 100 : 0;
  let windowLow = Number.POSITIVE_INFINITY;
  let argMaxClose = 0;
  let maxClose = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) continue;
    if (bar.low_qfq > 0 && bar.low_qfq < windowLow) windowLow = bar.low_qfq;
    if (bar.close_qfq > maxClose) {
      maxClose = bar.close_qfq;
      argMaxClose = i;
    }
  }
  const rangeGain =
    windowLow > 0 && Number.isFinite(windowLow) ? ((endClose - windowLow) / windowLow) * 100 : 0;
  const denom = bars.length - 1;
  const recencyScore = denom > 0 ? argMaxClose / denom : 0;
  const value = 0.5 * rWindow + 0.3 * rangeGain + RECENCY_BIAS * recencyScore;
  return { value, rWindow };
}
