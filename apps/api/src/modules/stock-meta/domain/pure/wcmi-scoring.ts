/**
 * Cross-sectional WCMI scoring engine.
 *
 * Architecture (batch-only — single-code path returns null for wcmi):
 *
 *   Phase A  extractRawFeatures(bars) per code   → WcmiRawFeatures
 *   Phase B  scoreUniverse(items)
 *            1. survivor filter (history + gate)
 *            2. percentile tables for each ranked dimension
 *            3. compose S_mom + S_exp via `bor()`; S_timing & P_fomo
 *               are absolute and already computed in raw
 *            4. percentile tables for the four module sums
 *            5. final = Σ w_module · norm(module)  ∈ [−1, +1]
 *
 * `bor` is a step function (top-1 % → +20, …, other → −20). Ties use
 * average rank. Negative-direction features are flipped before the
 * rank lookup so "rank from top" always means "best".
 *
 * Output is stored in `[-1, +1]`; the FE renders it through the
 * existing `returnColumn` cell (× 100, "%" suffix) so a +0.85 reads
 * as "+85.00 %"——a Sharpe-style score-in-percent unit.
 */

import type { BarLike } from './compute-metrics.js';

// ─────────────────────────────────────────────────────────────────
// Tunables (all in one place — bull-market default profile)
// ─────────────────────────────────────────────────────────────────

export const WCMI_CONFIG = {
  // ─── S_mom — multi-window return composite (rank inputs) ────────────
  /** Weight on bor(rank_r5).  ↑ = more weight on 1-week burst; ↓ = less
   *  short-term noise.  Range guidance: 1–4 (with W_R10 dominant). */
  W_R5: 2,
  /** Weight on bor(rank_r10).  Primary 2-week swing dial.
   *  ↑ = lean harder on the user's stated horizon. */
  W_R10: 5,
  /** Weight on bor(rank_r20).  Monthly trend confirmation.
   *  ↑ = require stronger backbone; ↓ = let pure 1-2 week movers rank up. */
  W_R20: 4,
  /** Weight on bor(rank_r60).  ~3-month context. Low weight so high-
   *  position chop doesn't dominate; raise only to favour established
   *  long uptrenders over fresh swingers. */
  W_R60: 1,
  /** Weight on bor(rank_r90).  ~4.5-month context — same role as r60.
   *  Use {@link BREAKOUT_BONUS} below if you want long uptrenders to
   *  re-emerge through breakout rather than raw r90 weighting. */
  W_R90: 1,
  /** r90 floor (pct) to qualify for the breakout bonus.  ↑ → bonus
   *  applies to fewer, stronger names. 100 % matches "doubled in 4.5
   *  months". */
  BREAKOUT_R90_THRESHOLD: 100,
  /** r5 / r10 ratio floor for the breakout bonus.  ↑ → require recent
   *  acceleration; ↓ → tolerate mild lull before re-acceleration.
   *  0.8 ≈ "5-day pace ≥ 80 % of 10-day pace". */
  BREAKOUT_R5_RATIO: 0.8,
  /** Absolute bonus added to `S_mom_raw` when both conditions above
   *  hold.  Sits alongside the rank composite; tune in bor units
   *  (each step is ±5). */
  BREAKOUT_BONUS: 20,

  // ─── S_exp — holding-experience composite (rank inputs) ─────────────
  /** Weight on bor(rank_kform_up_count).  Bullish marubozu count;
   *  higher rank → better.  Big rewards = "frequent strong sealed up
   *  days". */
  W_KFORM_UP: 2,
  /** Weight on bor(rank_kform_dn_count) **with -1 direction**.  More
   *  shaven-head black candles → more penalty. */
  W_KFORM_DN: 2,
  /** Weight on bor(rank_upper_shadow_count) **with -1 direction**.
   *  Frequent long upper shadows (rally-then-fade) → penalty. */
  W_UPPER_SHADOW: 1.5,
  /** Weight on bor(rank_lower_shadow_count) **+1 direction**.
   *  Frequent long lower shadows (dip-buying) → reward. */
  W_LOWER_SHADOW: 1.5,
  /** Weight on bor(rank_continuity_match_rate).  Higher 4-day-all-green
   *  rate → better.  Tune up if path quality (vs raw return) is what
   *  you care most about. */
  W_CONTINUITY: 2,
  /** Weight on bor(rank_green_rate).  Plain "% of days the stock
   *  closed above prev close" — independent of streak shape. */
  W_GREEN_RATE: 2,
  /** Weight on bor(rank_max_drawdown) **-1 direction**.  Lower peak-
   *  to-trough drawdown over the lookback → reward. */
  W_DRAWDOWN: 2,
  /** Weight on bor(rank_big_move_count) **-1 direction**.  |change| >
   *  {@link BIG_MOVE}; high frequency = jumpy stock, penalty. */
  W_BIG_MOVE: 1,
  /** Weight on bor(rank_low_open_count) **-1 direction**.  Gap <
   *  -2 %; frequent low opens hurts holding experience. */
  W_LOW_OPEN: 1,

  // ─── Window / threshold parameters ──────────────────────────────────
  /** S_exp count-based features look at the last N bars (here `bars.length`
   *  capped at this).  ↑ → more historical context, slower to react to
   *  regime change; ↓ → reacts faster but noisier. */
  LOOKBACK_DAYS: 50,
  /** "Big move" cutoff in pct: |change| > BIG_MOVE counts as a big
   *  bar.  Used by kform_up/dn detection (above) and big-move count.
   *  6 % covers daily limits in non-ChiNext A-share. */
  BIG_MOVE: 6,
  /** Long shadow cutoff in pct of prev_close.  upper_shadow / lower_
   *  shadow > LONG_SHADOW → counts toward the respective shadow rank
   *  input. */
  LONG_SHADOW: 3,
  /** "Big amplitude" cutoff (pct of prev_close); currently only used
   *  by the last-day anomaly check.  Symmetric to BIG_MOVE on
   *  purpose. */
  BIG_AMP: 6,
  /** Upper-shadow ceiling that lets a bar count as "光头" — must be
   *  below this for the kform_up classification.  Lower-shadow uses
   *  the same constant for 光脚. */
  SHAVED_SHADOW: 1,

  // ─── Continuity (4-day all-green rolling window) ────────────────────
  /** Window length for the continuity scan. */
  CONT_WINDOW: 4,
  /** Minimum number of close-up-vs-prev days inside the window for it
   *  to count as a "match". 4/4 == strict (every day green). */
  CONT_MIN_UP: 4,

  // ─── P_fomo — absolute penalties (un-ranked, summed) ────────────────
  /** Trigger r5 (pct) for the low-turnover FOMO penalty.  Need both:
   *  r5 > FOMO_R5_THR AND avg_turnover_5 < FOMO_TURNOVER_RATIO × avg_N. */
  FOMO_R5_THR: 25,
  /** Ratio of recent 5-bar avg turnover to baseline window. < this
   *  ratio + big r5 = "无量干拔". Tighter (lower) ratio → fewer
   *  triggers, more conservative. */
  FOMO_TURNOVER_RATIO: 0.8,
  /** Baseline turnover window (bars) used for the ratio above.  20 is
   *  ~1 month — recent enough to compare against current pump, long
   *  enough to be a stable baseline. */
  FOMO_AVG_WINDOW: 20,
  /** Fixed penalty added to P_fomo when low-turnover FOMO triggers.
   *  Tune relative to OB_* penalties for relative severity. */
  FOMO_LOW_TURNOVER_PEN: 30,
  /** Latest bar's change (pct) above which we consider a "limit-up
   *  candidate".  9.5 % comfortably above CSI 10 % limit accounting
   *  for fractional rounding. */
  LIMIT_UP_CHG: 9.5,
  /** Max amplitude (pct) for a sealed limit-up — the lower this is,
   *  the more we require the candle to literally have no range. */
  LIMIT_UP_AMP_MAX: 0.5,
  /** Fixed penalty added to P_fomo when last bar is a sealed
   *  一字涨停.  Kept "适度" so it can be visible to the user
   *  (open-up next day is plausible). */
  LIMIT_UP_PEN: 20,
  /** Bias_5 threshold above which overbought penalty starts accruing.
   *  Bull-market default: 12 %.  Lower = stricter "too far above
   *  ma5". */
  BIAS5_OB: 12,
  /** Bias_10 threshold for ma10-overbought penalty.  Bull default
   *  20 %.  Penalty is convex past threshold (see OB_P). */
  BIAS10_OB: 20,
  /** Multiplier on `(bias_5 − BIAS5_OB)^OB_P` — controls how fast
   *  ma5-overbought ramps. */
  OB_BIAS5_K: 1.5,
  /** Multiplier on `(bias_10 − BIAS10_OB)^OB_P` — higher than
   *  OB_BIAS5_K because ma10-overbought is more dangerous. */
  OB_BIAS10_K: 2.5,
  /** Convex exponent for the overbought penalty.  1.3 = mild
   *  convexity (a 5 % overshoot beyond threshold hurts ≈ 8 ×
   *  more than 1 %). */
  OB_P: 1.3,

  // ─── S_timing — absolute scoring (un-ranked) ────────────────────────
  /** MA distance window (pct) for the proximity reward.  Beyond
   *  this distance reward = 0; closer = linearly toward `MA_*_BASE`.
   *  Bigger → more permissive "near MA" definition. */
  MA_NEAR_RANGE: 4,
  /** Max proximity reward to ma10 (the user's preferred buy point).
   *  All three bases are independent — the maximum across ma5/10/20
   *  wins, no double counting. */
  MA_10_BASE: 8,
  /** Max proximity reward to ma5. */
  MA_5_BASE: 5,
  /** Max proximity reward to ma20. */
  MA_20_BASE: 3,
  /** Per-bar reward when a bar's low touches ma10 then closes above
   *  (effective support).  Accumulates across the lookback. */
  MA10_TOUCH_REWARD: 1.5,
  /** Per-bar reward when a bar's low touches ma5 then closes above. */
  MA5_TOUCH_REWARD: 1.0,
  /** Per-bar reward when a bar's low touches ma20 then closes above. */
  MA20_TOUCH_REWARD: 0.5,
  /** Per-bar penalty when prev close > ma10 AND today's close <
   *  ma10 AND change < MA10_BREAK_THR — "broke ma10 on a real
   *  down day". */
  MA10_BREAK_PEN: 2.5,
  /** Change-pct threshold (negative) below which a ma10 break counts.
   *  -2 → only "real" breaks (drift breaks ignored). */
  MA10_BREAK_THR: -2,
  /** Same as above for ma5 — lighter penalty (closer to noise). */
  MA5_BREAK_PEN: 1.5,
  /** Change-pct threshold below which a ma5 break counts. */
  MA5_BREAK_THR: -1.5,
  /** Last-bar |change| / amplitude threshold above which we start
   *  penalising the print (next-day reversal risk).  Bull default
   *  8 %. */
  LAST_DAY_THR: 8,
  /** Multiplier on `excess_change ^ LAST_P` for the directional part
   *  of last-day anomaly. */
  LAST_CHANGE_K: 1.5,
  /** Multiplier on `excess_amplitude ^ LAST_P` for the range part. */
  LAST_AMP_K: 1.0,
  /** Convex exponent for last-day anomaly. */
  LAST_P: 1.5,

  // ─── Final blend (module weights) ───────────────────────────────────
  /** Weight on `norm(S_mom)`.  Dominant — momentum is the primary
   *  signal for this scoring. */
  W_FINAL_MOM: 0.5,
  /** Weight on `norm(S_exp)`.  Holding experience — second-largest
   *  contributor. */
  W_FINAL_EXP: 0.3,
  /** Weight on `norm(S_timing)`.  Tactical entry — small but
   *  non-zero so an unfortunate buy point dings the score. */
  W_FINAL_TIMING: 0.1,
  /** Weight on `norm(P_fomo)` — subtracted from the final blend.
   *  Caps how badly bubble / unbuyable patterns can drag the score. */
  W_FINAL_FOMO: 0.1,
} as const;

// ─────────────────────────────────────────────────────────────────
// Raw feature extraction — phase A, single-bar-walk per code
// ─────────────────────────────────────────────────────────────────

/** Per-bar derived percentages (vs prev close). `null` slots mean the
 *  bar's prev close was missing or non-positive. */
interface BarMetrics {
  readonly change: number;
  readonly gap: number;
  readonly upperShadow: number;
  readonly lowerShadow: number;
  readonly amplitude: number;
}

/** All raw inputs the scoring engine needs from a single code.
 *  Either every field is populated, or the whole struct is `null`. */
export interface WcmiRawFeatures {
  // Returns — used for both gate (r10/r20) and ranking.
  readonly r5: number | null;
  readonly r10: number;
  readonly r20: number | null;
  readonly r60: number | null;
  readonly r90: number | null;
  /** Absolute bonus added to S_mom_raw after the rank composite. */
  readonly breakoutBonus: number;
  // S_exp ranked dimensions (counts / rates over the lookback tail).
  readonly kformUpCount: number;
  readonly kformDnCount: number;
  readonly upperShadowCount: number;
  readonly lowerShadowCount: number;
  readonly continuityMatchRate: number;
  readonly greenRate: number;
  readonly maxDrawdown: number;
  readonly bigMoveCount: number;
  readonly lowOpenCount: number;
  // Absolute modules — already in score units.
  readonly sTimingAbsolute: number;
  readonly pFomoAbsolute: number;
}

export function extractRawFeatures(bars: readonly BarLike[]): WcmiRawFeatures | null {
  if (bars.length < 11) return null;
  // r10 is mandatory for the gate.
  const r10 = computeRet(bars, 10);
  if (r10 === null) return null;
  const r5 = computeRet(bars, 5);
  const r20 = computeRet(bars, 20);
  const r60 = computeRet(bars, 60);
  const r90 = computeRet(bars, 90);

  // Breakout bonus eligibility — needs r5, r10, r90 all present.
  let breakoutBonus = 0;
  if (
    r5 !== null &&
    r90 !== null &&
    r90 > WCMI_CONFIG.BREAKOUT_R90_THRESHOLD &&
    r5 >= r10 * WCMI_CONFIG.BREAKOUT_R5_RATIO
  ) {
    breakoutBonus = WCMI_CONFIG.BREAKOUT_BONUS;
  }

  // Bar-level metrics over the entire history (cheap; reused below).
  const bm = buildBarMetrics(bars);
  const lookback = Math.min(WCMI_CONFIG.LOOKBACK_DAYS, bars.length - 1);
  const tail = bm.slice(bm.length - lookback);

  // Count-based + rate-based features.
  const counts = countKlineForms(tail);
  const continuityMatchRate = computeContinuityMatchRate(tail);
  const greenRate = computeGreenRate(tail);
  const maxDrawdown = computeMaxDrawdown(bars, lookback);

  // Absolute modules (S_timing + P_fomo).
  const closes = bars.map((b) => b.close_qfq);
  const ma5 = movingAverage(closes, 5);
  const ma10 = movingAverage(closes, 10);
  const ma20 = movingAverage(closes, 20);
  const latestM = bm[bm.length - 1] ?? null;
  const latestClose = closes[closes.length - 1]!;
  const ma5Last = ma5[ma5.length - 1] ?? null;
  const ma10Last = ma10[ma10.length - 1] ?? null;
  const ma20Last = ma20[ma20.length - 1] ?? null;

  const sTimingAbsolute =
    proximityMax(latestClose, ma5Last, ma10Last, ma20Last) +
    accumulateMaSupport(bars, bm, ma5, ma10, ma20, lookback) +
    (latestM !== null ? lastDayAnomalyPenalty(latestM) : 0);

  const pFomoAbsolute =
    overboughtPenalty(latestClose, ma5Last, ma10Last) +
    lowTurnoverFomoPenalty(bars, r5) +
    (latestM !== null && isLimitUpSealed(bars, latestM) ? WCMI_CONFIG.LIMIT_UP_PEN : 0);

  return {
    r5,
    r10,
    r20,
    r60,
    r90,
    breakoutBonus,
    kformUpCount: counts.kformUpCount,
    kformDnCount: counts.kformDnCount,
    upperShadowCount: counts.upperShadowCount,
    lowerShadowCount: counts.lowerShadowCount,
    continuityMatchRate,
    greenRate,
    maxDrawdown,
    bigMoveCount: counts.bigMoveCount,
    lowOpenCount: counts.lowOpenCount,
    sTimingAbsolute,
    pFomoAbsolute,
  };
}

// ─────────────────────────────────────────────────────────────────
// Universe scoring — phase B
// ─────────────────────────────────────────────────────────────────

export interface ScoringInput {
  readonly code: string;
  readonly raw: WcmiRawFeatures;
}

/**
 * Score every code against the universe. Returns a Map keyed by
 * `code`; values are `final ∈ [-1, +1]` for survivors, `null` for
 * codes that fail the trend gate (`ret_10d ≤ 0` or `ret_20d` present
 * and `≤ 0`).
 */
export function scoreUniverse(items: readonly ScoringInput[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (items.length === 0) return out;

  // Survivor filter — gate-failed codes get null and don't enter the
  // rank tables (they would warp the distribution otherwise).
  const survivors: ScoringInput[] = [];
  for (const it of items) {
    const r10 = it.raw.r10;
    if (r10 <= 0) {
      out.set(it.code, null);
      continue;
    }
    const r20 = it.raw.r20;
    if (r20 !== null && r20 <= 0) {
      out.set(it.code, null);
      continue;
    }
    survivors.push(it);
  }
  if (survivors.length === 0) return out;

  // ── Phase B.2: rank tables over survivors ─────────────────────
  const sorted = buildRankTables(survivors);

  // ── Phase B.3: compute S_mom_raw + S_exp_raw + S_timing + P_fomo per survivor
  type ModuleSums = {
    sMom: number;
    sExp: number;
    sTiming: number;
    pFomo: number;
  };
  const moduleSums = new Map<string, ModuleSums>();
  for (const it of survivors) {
    const r = it.raw;
    const sMom =
      WCMI_CONFIG.W_R5 * borFor(sorted.r5, r.r5, +1) +
      WCMI_CONFIG.W_R10 * borFor(sorted.r10, r.r10, +1) +
      WCMI_CONFIG.W_R20 * borFor(sorted.r20, r.r20, +1) +
      WCMI_CONFIG.W_R60 * borFor(sorted.r60, r.r60, +1) +
      WCMI_CONFIG.W_R90 * borFor(sorted.r90, r.r90, +1) +
      r.breakoutBonus;
    const sExp =
      WCMI_CONFIG.W_KFORM_UP * borFor(sorted.kformUpCount, r.kformUpCount, +1) +
      WCMI_CONFIG.W_KFORM_DN * borFor(sorted.kformDnCount, r.kformDnCount, -1) +
      WCMI_CONFIG.W_UPPER_SHADOW * borFor(sorted.upperShadowCount, r.upperShadowCount, -1) +
      WCMI_CONFIG.W_LOWER_SHADOW * borFor(sorted.lowerShadowCount, r.lowerShadowCount, +1) +
      WCMI_CONFIG.W_CONTINUITY * borFor(sorted.continuityMatchRate, r.continuityMatchRate, +1) +
      WCMI_CONFIG.W_GREEN_RATE * borFor(sorted.greenRate, r.greenRate, +1) +
      WCMI_CONFIG.W_DRAWDOWN * borFor(sorted.maxDrawdown, r.maxDrawdown, -1) +
      WCMI_CONFIG.W_BIG_MOVE * borFor(sorted.bigMoveCount, r.bigMoveCount, -1) +
      WCMI_CONFIG.W_LOW_OPEN * borFor(sorted.lowOpenCount, r.lowOpenCount, -1);
    moduleSums.set(it.code, {
      sMom,
      sExp,
      sTiming: r.sTimingAbsolute,
      pFomo: r.pFomoAbsolute,
    });
  }

  // ── Phase B.4: rank the four module sums over survivors
  const moduleSorted = {
    sMom: sortedFromMap(moduleSums, (m) => m.sMom),
    sExp: sortedFromMap(moduleSums, (m) => m.sExp),
    sTiming: sortedFromMap(moduleSums, (m) => m.sTiming),
    pFomo: sortedFromMap(moduleSums, (m) => m.pFomo),
  };

  // ── Phase B.5: compose final ∈ [-1, +1]
  for (const it of survivors) {
    const m = moduleSums.get(it.code)!;
    const final =
      WCMI_CONFIG.W_FINAL_MOM * normFromSorted(moduleSorted.sMom, m.sMom) +
      WCMI_CONFIG.W_FINAL_EXP * normFromSorted(moduleSorted.sExp, m.sExp) +
      WCMI_CONFIG.W_FINAL_TIMING * normFromSorted(moduleSorted.sTiming, m.sTiming) -
      WCMI_CONFIG.W_FINAL_FOMO * normFromSorted(moduleSorted.pFomo, m.pFomo);
    out.set(it.code, Number.isFinite(final) ? final : null);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Bor + percentile helpers
// ─────────────────────────────────────────────────────────────────

/** Step function on rank-from-top (0 = best). */
function bor(rankFromTop: number): number {
  if (rankFromTop < 0.01) return 20;
  if (rankFromTop < 0.05) return 15;
  if (rankFromTop < 0.1) return 10;
  if (rankFromTop < 0.2) return 5;
  if (rankFromTop < 0.3) return 0;
  if (rankFromTop < 0.4) return -5;
  if (rankFromTop < 0.5) return -10;
  return -20;
}

/** bor over a feature value; `direction = +1` means higher is better. */
function borFor(sorted: readonly number[], v: number | null, direction: 1 | -1): number {
  if (v === null) return -20; // missing data = bottom bucket
  const p = percentile(sorted, v);
  const rankFromTop = direction === 1 ? 1 - p : p;
  return bor(rankFromTop);
}

/** Average-rank percentile: `(low_count + 0.5·equal_count) / N`. */
function percentile(sorted: readonly number[], v: number): number {
  const N = sorted.length;
  if (N === 0) return 0.5;
  const firstGe = lowerBound(sorted, v);
  const firstGt = upperBound(sorted, v, firstGe);
  const lowCount = firstGe;
  const equalCount = firstGt - firstGe;
  return (lowCount + 0.5 * equalCount) / N;
}

/** First index with `arr[i] >= v` (binary search). */
function lowerBound(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with `arr[i] > v`, starting search at `from`. */
function upperBound(arr: readonly number[], v: number, from: number): number {
  let lo = from;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function normFromSorted(sorted: readonly number[], v: number): number {
  return clip(2 * percentile(sorted, v) - 1, -1, 1);
}

interface SortedTables {
  readonly r5: readonly number[];
  readonly r10: readonly number[];
  readonly r20: readonly number[];
  readonly r60: readonly number[];
  readonly r90: readonly number[];
  readonly kformUpCount: readonly number[];
  readonly kformDnCount: readonly number[];
  readonly upperShadowCount: readonly number[];
  readonly lowerShadowCount: readonly number[];
  readonly continuityMatchRate: readonly number[];
  readonly greenRate: readonly number[];
  readonly maxDrawdown: readonly number[];
  readonly bigMoveCount: readonly number[];
  readonly lowOpenCount: readonly number[];
}

function buildRankTables(survivors: readonly ScoringInput[]): SortedTables {
  return {
    r5: sortedFromItems(survivors, (s) => s.raw.r5),
    r10: sortedFromItems(survivors, (s) => s.raw.r10),
    r20: sortedFromItems(survivors, (s) => s.raw.r20),
    r60: sortedFromItems(survivors, (s) => s.raw.r60),
    r90: sortedFromItems(survivors, (s) => s.raw.r90),
    kformUpCount: sortedFromItems(survivors, (s) => s.raw.kformUpCount),
    kformDnCount: sortedFromItems(survivors, (s) => s.raw.kformDnCount),
    upperShadowCount: sortedFromItems(survivors, (s) => s.raw.upperShadowCount),
    lowerShadowCount: sortedFromItems(survivors, (s) => s.raw.lowerShadowCount),
    continuityMatchRate: sortedFromItems(survivors, (s) => s.raw.continuityMatchRate),
    greenRate: sortedFromItems(survivors, (s) => s.raw.greenRate),
    maxDrawdown: sortedFromItems(survivors, (s) => s.raw.maxDrawdown),
    bigMoveCount: sortedFromItems(survivors, (s) => s.raw.bigMoveCount),
    lowOpenCount: sortedFromItems(survivors, (s) => s.raw.lowOpenCount),
  };
}

function sortedFromItems(
  items: readonly ScoringInput[],
  pick: (s: ScoringInput) => number | null,
): readonly number[] {
  const out: number[] = [];
  for (const it of items) {
    const v = pick(it);
    if (v === null) continue;
    if (!Number.isFinite(v)) continue;
    out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

function sortedFromMap<V>(map: ReadonlyMap<string, V>, pick: (v: V) => number): readonly number[] {
  const out: number[] = [];
  for (const v of map.values()) {
    const x = pick(v);
    if (Number.isFinite(x)) out.push(x);
  }
  out.sort((a, b) => a - b);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Per-code raw extractors
// ─────────────────────────────────────────────────────────────────

function buildBarMetrics(bars: readonly BarLike[]): readonly (BarMetrics | null)[] {
  const out: (BarMetrics | null)[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    if (i === 0) {
      out[i] = null;
      continue;
    }
    out[i] = computeBarMetrics(bars[i - 1]!, bars[i]!);
  }
  return out;
}

function computeBarMetrics(prev: BarLike, cur: BarLike): BarMetrics | null {
  const prevClose = prev.close_qfq;
  if (prevClose <= 0) return null;
  const change = ((cur.close_qfq - prevClose) / prevClose) * 100;
  const gap = ((cur.open_qfq - prevClose) / prevClose) * 100;
  const bodyTop = Math.max(cur.open_qfq, cur.close_qfq);
  const bodyBottom = Math.min(cur.open_qfq, cur.close_qfq);
  const upperShadow = Math.max(((cur.high_qfq - bodyTop) / prevClose) * 100, 0);
  const lowerShadow = Math.max(((bodyBottom - cur.low_qfq) / prevClose) * 100, 0);
  const amplitude = Math.max(((cur.high_qfq - cur.low_qfq) / prevClose) * 100, 0);
  return { change, gap, upperShadow, lowerShadow, amplitude };
}

function movingAverage(closes: readonly number[], window: number): readonly (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (window <= 0 || closes.length < window) return out;
  let sum = 0;
  for (let i = 0; i < window; i += 1) sum += closes[i]!;
  out[window - 1] = sum / window;
  for (let i = window; i < closes.length; i += 1) {
    sum += closes[i]! - closes[i - window]!;
    out[i] = sum / window;
  }
  return out;
}

function computeRet(bars: readonly BarLike[], T: number): number | null {
  if (bars.length <= T) return null;
  const base = bars[bars.length - 1 - T]!.close_qfq;
  if (base <= 0) return null;
  const latest = bars[bars.length - 1]!.close_qfq;
  return ((latest - base) / base) * 100;
}

interface FormCounts {
  readonly kformUpCount: number;
  readonly kformDnCount: number;
  readonly upperShadowCount: number;
  readonly lowerShadowCount: number;
  readonly bigMoveCount: number;
  readonly lowOpenCount: number;
}

function countKlineForms(tail: readonly (BarMetrics | null)[]): FormCounts {
  let kformUpCount = 0;
  let kformDnCount = 0;
  let upperShadowCount = 0;
  let lowerShadowCount = 0;
  let bigMoveCount = 0;
  let lowOpenCount = 0;
  for (const m of tail) {
    if (m === null) continue;
    if (m.change > WCMI_CONFIG.BIG_MOVE && m.upperShadow < WCMI_CONFIG.SHAVED_SHADOW) {
      kformUpCount += 1;
    }
    if (m.change < -WCMI_CONFIG.BIG_MOVE && m.lowerShadow < WCMI_CONFIG.SHAVED_SHADOW) {
      kformDnCount += 1;
    }
    if (m.upperShadow > WCMI_CONFIG.LONG_SHADOW) upperShadowCount += 1;
    if (m.lowerShadow > WCMI_CONFIG.LONG_SHADOW) lowerShadowCount += 1;
    if (Math.abs(m.change) > WCMI_CONFIG.BIG_MOVE) bigMoveCount += 1;
    if (m.gap < -2) lowOpenCount += 1;
  }
  return {
    kformUpCount,
    kformDnCount,
    upperShadowCount,
    lowerShadowCount,
    bigMoveCount,
    lowOpenCount,
  };
}

function computeContinuityMatchRate(tail: readonly (BarMetrics | null)[]): number {
  const W = WCMI_CONFIG.CONT_WINDOW;
  if (tail.length < W) return 0;
  let matches = 0;
  let total = 0;
  for (let i = 0; i <= tail.length - W; i += 1) {
    let greens = 0;
    let cum = 0;
    let bad = false;
    for (let j = i; j < i + W; j += 1) {
      const m = tail[j] ?? null;
      if (m === null) {
        bad = true;
        break;
      }
      if (m.change > 0) greens += 1;
      cum += m.change;
    }
    if (bad) continue;
    total += 1;
    if (greens >= WCMI_CONFIG.CONT_MIN_UP && cum > 0) matches += 1;
  }
  if (total === 0) return 0;
  return matches / total;
}

function computeGreenRate(tail: readonly (BarMetrics | null)[]): number {
  let up = 0;
  let total = 0;
  for (const m of tail) {
    if (m === null) continue;
    total += 1;
    if (m.change > 0) up += 1;
  }
  if (total === 0) return 0;
  return up / total;
}

function computeMaxDrawdown(bars: readonly BarLike[], lookback: number): number {
  const tail = bars.slice(bars.length - Math.min(lookback, bars.length));
  let peak = -Infinity;
  let maxDd = 0;
  for (const b of tail) {
    if (b.close_qfq > peak) peak = b.close_qfq;
    if (peak <= 0) continue;
    const dd = ((peak - b.close_qfq) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

// ─────────────────────────────────────────────────────────────────
// S_timing — absolute scoring helpers (unchanged from previous spec)
// ─────────────────────────────────────────────────────────────────

function proximityMax(
  close: number,
  ma5: number | null,
  ma10: number | null,
  ma20: number | null,
): number {
  return Math.max(
    proximityReward(close, ma10, WCMI_CONFIG.MA_10_BASE),
    proximityReward(close, ma5, WCMI_CONFIG.MA_5_BASE),
    proximityReward(close, ma20, WCMI_CONFIG.MA_20_BASE),
    0,
  );
}

function proximityReward(close: number, ma: number | null, base: number): number {
  if (ma === null || ma <= 0) return 0;
  const bias = (Math.abs(close - ma) / ma) * 100;
  return base * Math.max(0, 1 - bias / WCMI_CONFIG.MA_NEAR_RANGE);
}

function accumulateMaSupport(
  bars: readonly BarLike[],
  bm: readonly (BarMetrics | null)[],
  ma5: readonly (number | null)[],
  ma10: readonly (number | null)[],
  ma20: readonly (number | null)[],
  lookbackBars: number,
): number {
  const tailFrom = bars.length - Math.min(lookbackBars, bars.length);
  let total = 0;
  for (let i = tailFrom; i < bars.length; i += 1) {
    if (i === 0) continue;
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const m = bm[i] ?? null;
    const ma5i = ma5[i] ?? null;
    const ma10i = ma10[i] ?? null;
    const ma20i = ma20[i] ?? null;
    if (ma10i !== null) {
      if (cur.low_qfq <= ma10i && cur.close_qfq > ma10i) total += WCMI_CONFIG.MA10_TOUCH_REWARD;
      if (
        m !== null &&
        prev.close_qfq > ma10i &&
        cur.close_qfq < ma10i &&
        m.change < WCMI_CONFIG.MA10_BREAK_THR
      )
        total -= WCMI_CONFIG.MA10_BREAK_PEN;
    }
    if (ma5i !== null) {
      if (cur.low_qfq <= ma5i && cur.close_qfq > ma5i) total += WCMI_CONFIG.MA5_TOUCH_REWARD;
      if (
        m !== null &&
        prev.close_qfq > ma5i &&
        cur.close_qfq < ma5i &&
        m.change < WCMI_CONFIG.MA5_BREAK_THR
      )
        total -= WCMI_CONFIG.MA5_BREAK_PEN;
    }
    if (ma20i !== null) {
      if (cur.low_qfq <= ma20i && cur.close_qfq > ma20i) total += WCMI_CONFIG.MA20_TOUCH_REWARD;
    }
  }
  return total;
}

function lastDayAnomalyPenalty(latest: BarMetrics): number {
  const exChg = Math.max(0, Math.abs(latest.change) - WCMI_CONFIG.LAST_DAY_THR);
  const exAmp = Math.max(0, latest.amplitude - WCMI_CONFIG.LAST_DAY_THR);
  if (exChg === 0 && exAmp === 0) return 0;
  return -(
    Math.pow(exChg, WCMI_CONFIG.LAST_P) * WCMI_CONFIG.LAST_CHANGE_K +
    Math.pow(exAmp, WCMI_CONFIG.LAST_P) * WCMI_CONFIG.LAST_AMP_K
  );
}

// ─────────────────────────────────────────────────────────────────
// P_fomo — absolute scoring helpers
// ─────────────────────────────────────────────────────────────────

function overboughtPenalty(close: number, ma5: number | null, ma10: number | null): number {
  let pen = 0;
  if (ma5 !== null && ma5 > 0) {
    const bias5 = ((close - ma5) / ma5) * 100;
    if (bias5 > WCMI_CONFIG.BIAS5_OB) {
      pen += Math.pow(bias5 - WCMI_CONFIG.BIAS5_OB, WCMI_CONFIG.OB_P) * WCMI_CONFIG.OB_BIAS5_K;
    }
  }
  if (ma10 !== null && ma10 > 0) {
    const bias10 = ((close - ma10) / ma10) * 100;
    if (bias10 > WCMI_CONFIG.BIAS10_OB) {
      pen += Math.pow(bias10 - WCMI_CONFIG.BIAS10_OB, WCMI_CONFIG.OB_P) * WCMI_CONFIG.OB_BIAS10_K;
    }
  }
  return pen;
}

function lowTurnoverFomoPenalty(bars: readonly BarLike[], r5: number | null): number {
  if (r5 === null || r5 <= WCMI_CONFIG.FOMO_R5_THR) return 0;
  if (bars.length < WCMI_CONFIG.FOMO_AVG_WINDOW) return 0;
  const avg5 = avgTurnover(bars.slice(-5));
  const avgN = avgTurnover(bars.slice(-WCMI_CONFIG.FOMO_AVG_WINDOW));
  if (avgN <= 0) return 0;
  if (avg5 < avgN * WCMI_CONFIG.FOMO_TURNOVER_RATIO) return WCMI_CONFIG.FOMO_LOW_TURNOVER_PEN;
  return 0;
}

function avgTurnover(bars: readonly BarLike[]): number {
  if (bars.length === 0) return 0;
  let s = 0;
  for (const b of bars) s += b.turnover;
  return s / bars.length;
}

function isLimitUpSealed(bars: readonly BarLike[], latestM: BarMetrics): boolean {
  const last = bars[bars.length - 1];
  if (last === undefined) return false;
  return (
    last.high_qfq === last.low_qfq &&
    latestM.change > WCMI_CONFIG.LIMIT_UP_CHG &&
    latestM.amplitude < WCMI_CONFIG.LIMIT_UP_AMP_MAX
  );
}

// ─────────────────────────────────────────────────────────────────
// Misc utilities
// ─────────────────────────────────────────────────────────────────

function clip(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
