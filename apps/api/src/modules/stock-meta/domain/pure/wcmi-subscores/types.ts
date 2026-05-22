/**
 * Type definitions for the WCMI v2 (90-day wave-quality) scoring
 * engine. Per `docs/perf/wcmi-redesign.md`. Tuned defaults converged
 * via `apps/api/scripts/wcmi-backtest.ts` — see
 * `docs/perf/wcmi-redesign-backtest.md` for the round-by-round log.
 */

export interface WcmiConfig {
  // ── Sampling window ────────────────────────────────────────────────
  /**
   * Trailing-bar count over which every sub-score is computed.
   * Default 90 trading days ≈ a quarter — long enough to expose
   * multiple swings, short enough to react to regime changes. Codes
   * with `bars.length < 30` get `null`; `30 ≤ bars.length < WINDOW`
   * falls back to the available history (a `windowLen` field on
   * `WcmiSubscores` records the actual count used).
   */
  readonly WINDOW: number;

  // ── Sub-score 1: rhythm ────────────────────────────────────────────
  /**
   * "Ideal" lag-1 daily-return autocorrelation. We score
   * `−|lag1_autocorr − RHYTHM_TARGET|` so stocks whose returns mildly
   * persist day-to-day rank highest — that's the autocorrelation
   * signature of a clean swing. Pure random walk = 0, momentum
   * blow-off = high positive, frequent reversals = negative. 0.15
   * is the empirical sweet spot for A-share daily bars.
   */
  readonly RHYTHM_TARGET: number;

  /**
   * Reference period (in bars) for "one swing." `swing_density` is
   * normalised against `WINDOW / SWING_PERIOD_BARS`, so at WINDOW=90
   * a density of 1.0 means roughly one peak-trough cycle every 15
   * bars (≈ 3 weeks) — visually identifiable medium-term swings.
   */
  readonly SWING_PERIOD_BARS: number;

  // ── Sub-score 5: upper-shadow penalty ──────────────────────────────
  /**
   * Threshold for `upper_shadow / body`. At this ratio the per-bar
   * penalty saturates at 1.0 (i.e. a shadow ≥ 1.5× the body length
   * counts as "fully bad"). Below this the penalty scales linearly.
   * Higher value = more lenient.
   */
  readonly SHADOW_BODY_THR: number;

  /**
   * Threshold for `upper_shadow / day_range`. At this ratio the
   * per-bar penalty saturates at 1.0. 0.4 means a shadow taking up
   * ≥ 40% of the high-low range fully penalises the bar.
   */
  readonly SHADOW_RANGE_THR: number;

  // ── Sub-score 7: crash avoidance ───────────────────────────────────
  /**
   * Single-day percentage drop (positive number, in %) that counts
   * as a "crash day." Bars with `change_pct < -CRASH_DAY_THR`
   * contribute to `crash_days` and feed the severity term. 7%
   * captures genuine flush days while ignoring routine ±3-5%
   * volatility on growth names.
   */
  readonly CRASH_DAY_THR: number;

  /**
   * Cap on `crash_days / CRASH_COUNT_CAP` before clipping to 1.0.
   * 4 crash days in the window saturates the count penalty —
   * beyond that the dimension can't get any worse. Keeps a single
   * super-volatile name from dominating the percentile ranking.
   */
  readonly CRASH_COUNT_CAP: number;

  /**
   * Threshold for unrecovered gap-down opens (negative %, in %).
   * Bars where `open < prev_close × (1 + GAP_DOWN_THR/100)` AND
   * the bar didn't close yang are flagged. -2 catches meaningful
   * gap-downs without firing on routine -0.5% opens.
   */
  readonly GAP_DOWN_THR: number;

  /**
   * Saturation cap for gap-down day count, analogous to
   * `CRASH_COUNT_CAP`. 6 unrecovered gap-downs in 90 bars
   * saturates the penalty.
   */
  readonly GAP_DOWN_CAP: number;

  // ── Composite weights (need not sum to 100; the composite formula
  //    normalises by `Σ w_k`). Tuned via 7-round backtest run; see
  //    `docs/perf/wcmi-redesign-backtest.md` for the rationale. ──────
  /**
   * Weight on the `rhythm` sub-score (lag-1 autocorr + swing
   * density). Tuned to 0: at the top of the trailing-60d-gain
   * universe `swing_density ≥ 2` saturates label_rhythm for most
   * codes, so this dimension contributes mostly noise to the rank.
   */
  readonly W_RHYTHM: number;

  /**
   * Weight on the `ma_support` sub-score (above-ma20/60 rates,
   * bullish 4-MA alignment, mean distance above ma20). Tuned to 3
   * — small but non-zero tiebreaker for the aesthetic group.
   */
  readonly W_MA_SUPPORT: number;

  /**
   * Weight on the `up_wave_smoothness` sub-score (yang runs,
   * intra-swing drawdown, OLS R² on up segments). Tuned to 3 —
   * same tiebreaker role as `W_MA_SUPPORT`.
   */
  readonly W_UP_WAVE: number;

  /**
   * Weight on the `yang_dominance` sub-score (ratio of bars with
   * close>open). Tuned to 3 — same tiebreaker role.
   */
  readonly W_YANG_DOM: number;

  /**
   * Weight on the `upper_shadow_clean` sub-score (1 −
   * weighted-mean per-bar shadow penalty). Tuned to 3 — initially
   * the design's heaviest aesthetic weight (20), but backtest
   * showed it correlated weakly (sometimes negatively) with label
   * aesthetic in the top tier, so it joins the 4×3 tiebreaker
   * group.
   */
  readonly W_SHADOW_CLEAN: number;

  /**
   * Weight on the `stage_gain` sub-score (r_window + range_gain
   * + recency bonus). Tuned to 28 — stage-gain is the primary
   * filter intent, but raw gain saturates within the top tier so
   * crash_avoidance discriminates further.
   */
  readonly W_STAGE_GAIN: number;

  /**
   * Weight on the `crash_avoidance` sub-score (crash-day count +
   * severity + gap-down count). Tuned to 60 — the only dimension
   * with meaningful variance within already-high-stage-gain
   * stocks. Drives Top-10 discrimination.
   */
  readonly W_CRASH_AVOID: number;

  // ── Output scaling ─────────────────────────────────────────────────
  /**
   * Output ceiling for the composite WCMI score. Composite =
   * `(WCMI_TOTAL_SCALE / Σ w_k) × Σ (w_k × pct_k)` where each
   * `pct_k ∈ [0, 1]` is the cross-sectional percentile. With
   * `WCMI_TOTAL_SCALE = 1000` and any positive weight set, the
   * composite lives in `[0, 1000]` with median ≈ 500.
   */
  readonly WCMI_TOTAL_SCALE: number;
}

export const WCMI_CONFIG: WcmiConfig = {
  WINDOW: 90,
  RHYTHM_TARGET: 0.15,
  SWING_PERIOD_BARS: 15,
  SHADOW_BODY_THR: 1.5,
  SHADOW_RANGE_THR: 0.4,
  CRASH_DAY_THR: 7,
  CRASH_COUNT_CAP: 4,
  GAP_DOWN_THR: -2,
  GAP_DOWN_CAP: 6,
  W_RHYTHM: 0,
  W_MA_SUPPORT: 3,
  W_UP_WAVE: 3,
  W_YANG_DOM: 3,
  W_SHADOW_CLEAN: 3,
  W_STAGE_GAIN: 28,
  W_CRASH_AVOID: 60,
  WCMI_TOTAL_SCALE: 1000,
} as const;

export interface WcmiSubscores {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
  readonly windowLen: number;
  readonly passesGate: boolean;
}

export interface WcmiPctBreakdown {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
}

export interface WcmiScore {
  readonly composite: number;
  readonly pct: WcmiPctBreakdown;
}

export interface ScoringInput {
  readonly code: string;
  readonly raw: WcmiSubscores;
}
