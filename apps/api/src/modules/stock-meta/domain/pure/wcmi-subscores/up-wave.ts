import type { BarLike } from '../compute-metrics.js';
import type { WcmiConfig } from './types.js';
import { clip, olsR2 } from './utils.js';

/**
 * Up-wave smoothness sub-score: long yang runs, low intra-swing
 * drawdown, steady slope across qualifying advancing segments.
 */
export function computeUpWaveSmoothness(
  bars: readonly BarLike[],
  config: WcmiConfig,
): number {
  const yangRuns = collectYangRunLengths(bars);
  const maxYangRun = yangRuns.length === 0 ? 0 : Math.max(...yangRuns);
  const meanYangRun = yangRuns.length === 0 ? 0 : mean(yangRuns);
  const segments = collectUpSegments(bars);
  const meanSwingDd = segments.length === 0 ? 0 : mean(segments.map(swingDrawdown));
  const slopeR2Values = segments
    .filter((seg) => seg.length >= config.MIN_SEGMENT_BARS)
    .map((seg) => segmentR2(seg));
  const meanSlopeR2 =
    slopeR2Values.length === 0 ? config.DEFAULT_SLOPE_R2 : mean(slopeR2Values);
  return (
    0.35 * clip(maxYangRun / config.MAX_YANG_RUN_CAP, 0, 1) +
    0.25 * clip(meanYangRun / config.MEAN_YANG_RUN_CAP, 0, 1) +
    0.25 * (1 - clip(meanSwingDd / config.MEAN_SWING_DD_CAP, 0, 1)) +
    0.15 * meanSlopeR2
  );
}

function collectYangRunLengths(bars: readonly BarLike[]): number[] {
  const lengths: number[] = [];
  let cur = 0;
  for (const bar of bars) {
    if (bar.close_qfq > bar.open_qfq) {
      cur += 1;
    } else if (cur > 0) {
      lengths.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) lengths.push(cur);
  return lengths;
}

function collectUpSegments(bars: readonly BarLike[]): number[][] {
  const segments: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) continue;
    const close = bar.close_qfq;
    if (cur.length === 0) {
      cur = [close];
      continue;
    }
    const last = cur[cur.length - 1];
    if (last !== undefined && close >= last) {
      cur.push(close);
    } else {
      if (cur.length >= 2) segments.push(cur);
      cur = [close];
    }
  }
  if (cur.length >= 2) segments.push(cur);
  return segments;
}

function swingDrawdown(segment: readonly number[]): number {
  let peak = segment[0] ?? 0;
  let maxDd = 0;
  for (const v of segment) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function segmentR2(segment: readonly number[]): number {
  const xs: number[] = [];
  for (let i = 0; i < segment.length; i += 1) xs.push(i);
  return olsR2(xs, segment);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}
