/**
 * Pure geometry for the per-holding return-distribution boxplot.
 *
 * Input: one summary row per holding (from BacktestEvaluateResponse).
 *   Each row contributes a vertical box at column `i`:
 *     - whiskers   p05..p95
 *     - IQR box    p25..p75
 *     - median line at p50
 *     - mean dot
 *
 * Output: an array of `BoxColumn`s in SVG user-space coordinates plus
 * the shared Y-axis tick positions. Renderer just maps these to <line>
 * / <rect> / <circle> / <text> — no math in the React component.
 *
 * Why pure: lets us snapshot-test the layout deterministically; the
 * renderer becomes a thin mapping with no logic to misread.
 */

export interface BoxStat {
  readonly label: string;
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly p05: number;
  readonly p25: number;
  readonly p75: number;
  readonly p95: number;
  /** Optional universe-baseline mean for this holding. */
  readonly baselineMean?: number | null;
}

export interface BoxLayoutOptions {
  readonly width: number;
  readonly height: number;
  /** [left, top, right, bottom] padding inside the SVG viewport. */
  readonly padding: readonly [number, number, number, number];
  /** Approximate number of Y-axis ticks; actual count picks a nice step. */
  readonly tickHint?: number;
}

export interface BoxColumn {
  readonly label: string;
  readonly n: number;
  /** Center X of the column in SVG user units. */
  readonly cx: number;
  /** Half-width of the IQR rectangle. */
  readonly halfWidth: number;
  /** Y position of each statistic in SVG user units (top=0, bottom=height). */
  readonly yMedian: number;
  readonly yMean: number;
  readonly yP05: number;
  readonly yP25: number;
  readonly yP75: number;
  readonly yP95: number;
  /** Y of the universe baseline; null when no baseline supplied. */
  readonly yBaseline: number | null;
  /** Raw baseline mean (echoed for hover labels); null when absent. */
  readonly baselineMean: number | null;
}

export interface YTick {
  /** Return as a fraction (e.g. 0.05 = 5%). */
  readonly value: number;
  /** Y position in SVG user units. */
  readonly y: number;
}

export interface BoxLayout {
  readonly columns: readonly BoxColumn[];
  readonly yTicks: readonly YTick[];
  readonly yZero: number;
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  readonly plotBottom: number;
}

/**
 * Build the SVG-coordinate layout from raw summary stats. Empty input
 * (or every column having n=0) returns zero columns and a placeholder
 * axis spanning ±5 %, so the caller can still render an empty grid.
 */
export function computeBoxLayout(
  stats: readonly BoxStat[],
  opts: BoxLayoutOptions,
): BoxLayout {
  const [padL, padT, padR, padB] = opts.padding;
  const plotLeft = padL;
  const plotRight = opts.width - padR;
  const plotTop = padT;
  const plotBottom = opts.height - padB;
  const plotWidth = Math.max(plotRight - plotLeft, 1);
  const plotHeight = Math.max(plotBottom - plotTop, 1);

  const populated = stats.filter((s) => s.n > 0);
  const { yMin, yMax } = computeDomain(populated);
  const ticks = niceTicks(yMin, yMax, opts.tickHint ?? 5);

  // Use the actual rendered domain (which may have been widened by the
  // tick generator) so the box bottom/top sit *exactly* on a gridline.
  const firstTick = ticks[0];
  const lastTick = ticks[ticks.length - 1];
  const domainMin = firstTick === undefined ? yMin : Math.min(firstTick, yMin);
  const domainMax = lastTick === undefined ? yMax : Math.max(lastTick, yMax);
  const yOf = (v: number): number =>
    plotBottom - ((v - domainMin) / Math.max(domainMax - domainMin, 1e-9)) * plotHeight;

  const colCount = stats.length;
  const colWidth = colCount > 0 ? plotWidth / colCount : 0;
  const halfWidth = Math.max(Math.min(colWidth * 0.32, 28), 4);
  const columns: BoxColumn[] = stats.map((s, i) =>
    columnAt(s, plotLeft + colWidth * (i + 0.5), halfWidth, yOf),
  );

  return {
    columns,
    yTicks: ticks.map((v) => ({ value: v, y: yOf(v) })),
    yZero: yOf(0),
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
  };
}

// -- internals --------------------------------------------------------------

function columnAt(
  s: BoxStat,
  cx: number,
  halfWidth: number,
  yOf: (v: number) => number,
): BoxColumn {
  const baselineMean = s.baselineMean ?? null;
  const yBaseline = baselineMean === null ? null : yOf(baselineMean);
  if (s.n === 0) {
    const yz = yOf(0);
    return {
      label: s.label,
      n: 0,
      cx,
      halfWidth,
      yMedian: yz,
      yMean: yz,
      yP05: yz,
      yP25: yz,
      yP75: yz,
      yP95: yz,
      yBaseline,
      baselineMean,
    };
  }
  return {
    label: s.label,
    n: s.n,
    cx,
    halfWidth,
    yMedian: yOf(s.median),
    yMean: yOf(s.mean),
    yP05: yOf(s.p05),
    yP25: yOf(s.p25),
    yP75: yOf(s.p75),
    yP95: yOf(s.p95),
    yBaseline,
    baselineMean,
  };
}

interface Domain {
  readonly yMin: number;
  readonly yMax: number;
}

function computeDomain(stats: readonly BoxStat[]): Domain {
  if (stats.length === 0) {
    return { yMin: -0.05, yMax: 0.05 };
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const s of stats) {
    [lo, hi] = absorb(lo, hi, valuesOf(s));
  }
  // Always include zero so positive/negative reading is unambiguous.
  if (lo > 0) lo = 0;
  if (hi < 0) hi = 0;
  // 8% margin on each side keeps the extreme whiskers off the frame.
  const span = Math.max(hi - lo, 1e-6);
  const margin = span * 0.08;
  return { yMin: lo - margin, yMax: hi + margin };
}

function valuesOf(s: BoxStat): number[] {
  const out = [s.p05, s.p95, s.mean];
  if (s.baselineMean !== undefined && s.baselineMean !== null) out.push(s.baselineMean);
  return out;
}

function absorb(lo: number, hi: number, values: readonly number[]): [number, number] {
  let nextLo = lo;
  let nextHi = hi;
  for (const v of values) {
    if (v < nextLo) nextLo = v;
    if (v > nextHi) nextHi = v;
  }
  return [nextLo, nextHi];
}

/**
 * Tick generator: rounds the domain to a "nice" multiple of 1/2/5×10^k
 * and emits up to `count`-ish ticks. Matches the d3-style heuristic but
 * with no dependency.
 */
function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const step = niceStep(span / Math.max(count, 2));
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = first; v <= hi + step * 0.5; v += step) {
    // Snap to grid to avoid float drift after repeated addition.
    out.push(Math.round(v / step) * step);
  }
  return out;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let mult: number;
  if (norm < 1.5) mult = 1;
  else if (norm < 3) mult = 2;
  else if (norm < 7) mult = 5;
  else mult = 10;
  return mult * mag;
}
