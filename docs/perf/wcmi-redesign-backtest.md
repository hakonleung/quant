# WCMI Backtest Changelog

Rolling log of self-evaluation rounds against `data/kline/*.parquet`.
See `docs/perf/wcmi-redesign.md` § 自评与调优流程 for the methodology.

## 2026-05-22 — baseline (default WCMI_CONFIG)
- spearman_rho: 0.6083
- overlap_top30: 0.600
- overlap_top10: 0.200
- false_negative_count: 4
- false_positive_count: 0
- report: `docs/perf/data/wcmi-backtest-2026-05-22.json`

## 2026-05-22 — round 1 (rebalance weights toward label proportions)
- diff vs default: `W_RHYTHM 10→15, W_MA_SUPPORT 15→11, W_UP_WAVE 15→11, W_YANG_DOM 10→11, W_SHADOW_CLEAN 20→12, W_STAGE_GAIN 20 (unchanged), W_CRASH_AVOID 10→20` (sum 100).
- hypothesis: WCMI's normalised weight split (rhythm 10% / aesthetic 60% / stage 20% / crash 10%) is misaligned with the label formula (15 / 45 / 20 / 20). Realign so the composite weight on each group matches the label, and split the aesthetic group equally (25% each) as the label does.
- spearman_rho: 0.7206
- overlap_top30: 0.567
- overlap_top10: 0.400
- false_negative_count: 4
- false_positive_count: 0
- observation: ρ crossed the 0.70 target (+0.11) and top-10 doubled (0.20→0.40), but top-30 actually fell. Inspection of the top-label codes (000711 / 001259 / 003004 / 603779 / 300489) shows they share a profile of saturated label rhythm (swingDensity ≥ 2 saturates the label rhythm at 100) plus very high label crashAvoid (≥85), while their raw `rhythm` percentile is low (0.01–0.10) and their `maSupport`/`yangDominance` percentiles are also low. The label rhythm formula is mostly a saturation flag for "any non-trivial swing density", whereas the WCMI raw rhythm is a continuous distance-to-target; the two diverge sharply for the top tier. The truly discriminating signals within the top tier are `stageGain` and `crashAvoidance`.

## 2026-05-22 — round 2 (push composite onto stage + crash)
- diff vs default: `W_RHYTHM 10 (unchanged), W_MA_SUPPORT 15→6, W_UP_WAVE 15→6, W_YANG_DOM 10→6, W_SHADOW_CLEAN 20→7, W_STAGE_GAIN 20→30, W_CRASH_AVOID 10→35` (sum 100).
- hypothesis: among gain-leaders the within-cohort dispersion in raw aesthetic is tiny (label aesthetic 43–51 across the top-15), so the aesthetic group is mostly noise. Shrink aesthetic to ~25% of the composite and pour the freed weight into stage + crash. Keep rhythm flat — label rhythm is mostly saturated.
- spearman_rho: 0.8585
- overlap_top30: 0.667
- overlap_top10: 0.400
- false_negative_count: 0
- false_positive_count: 0
- observation: large jump in ρ (+0.14) and false-negatives cleared. Top-30 improved (0.60→0.67) but still short of 0.70; top-10 stuck at 0.40. Top-10 label misses now: 000711 (wcmi rank 12), 001259 (18), 300069 (34), 300489 (11), 003004 (33), 603779 (49). All have crashAvoid pct ≥ 0.66 (already heavily weighted) but very low aesthetic pct — they're being out-ranked by codes with similar crash+stage but stronger aesthetic. Next: cut aesthetic weight further; the remaining gap is "aesthetic group is still discriminating between top codes incorrectly".

## 2026-05-22 — round 3 (collapse aesthetic to near-zero)
- diff vs default: `W_RHYTHM 10 (unchanged), W_MA_SUPPORT 15→2, W_UP_WAVE 15→2, W_YANG_DOM 10→2, W_SHADOW_CLEAN 20→2, W_STAGE_GAIN 20→35, W_CRASH_AVOID 10→47` (sum 100).
- hypothesis: aesthetic isn't just over-weighted, it's actively miscalibrated within the top tier — see round-2 observation. Push aesthetic group to ~8% of the composite so it provides only a tiebreaker, and split the freed mass between stage and crash with crash still dominant.
- spearman_rho: 0.8656
- overlap_top30: 0.767
- overlap_top10: 0.400
- false_negative_count: 0
- false_positive_count: 0
- observation: top-30 jumps to 0.767 ✓ (target met) and ρ holds at 0.87. Top-10 unchanged at 0.40 — the codes that get into wcmi top-10 (002980, 603115, 003018, 300903, 002008) all have crash pct in the 0.74–0.81 band but the missing label top-10 codes have label crashAvoid ≥ 0.86. Label `stage_gain` is capped at 100 for almost the entire top-15 (stage_gain raw ≥ 1.5 ⇒ saturated label), so it stops discriminating within top tier; the only label signal that still varies meaningfully there is `crashAvoid`. Next: keep stage modest, push crash much harder.

## 2026-05-22 — round 4 (crash-dominant)
- diff vs default: `W_RHYTHM 10→5, W_MA_SUPPORT 15→2, W_UP_WAVE 15→2, W_YANG_DOM 10→2, W_SHADOW_CLEAN 20→2, W_STAGE_GAIN 20→17, W_CRASH_AVOID 10→70` (sum 100).
- hypothesis: per round 3, crash is the only label dimension that discriminates within the top tier. Bump W_CRASH_AVOID to 70 and bring everything else down.
- spearman_rho: 0.7290
- overlap_top30: 0.633
- overlap_top10: 0.600
- false_negative_count: 0
- false_positive_count: 0
- observation: top-10 hit 0.60 ✓, but ρ collapsed by 0.14 and top-30 dropped to 0.633. Crash-only ordering ignores label's stage_gain entirely, which still ranks across the broader top-30. Rounds 3 and 4 are local optima at opposite ends — there's a smooth trade-off between top-10 and top-30/ρ as a function of W_CRASH_AVOID.

## 2026-05-22 — round 5 (bisect rounds 3 and 4)
- diff vs default: `W_RHYTHM 10→8, W_MA_SUPPORT 15→2, W_UP_WAVE 15→2, W_YANG_DOM 10→2, W_SHADOW_CLEAN 20→2, W_STAGE_GAIN 20→24, W_CRASH_AVOID 10→60` (sum 100).
- hypothesis: W_CRASH_AVOID between 47 (round 3) and 70 (round 4) should land all four metrics in range simultaneously.
- spearman_rho: 0.7893
- overlap_top30: 0.733
- overlap_top10: 0.500
- false_negative_count: 0
- false_positive_count: 0
- observation: three criteria met; top-10 sits at 0.50 — one swap short of 0.60. Try slightly higher crash.

## 2026-05-22 — round 6 (crash up to 66)
- diff vs default: `W_RHYTHM 10→6, W_MA_SUPPORT 15→2, W_UP_WAVE 15→2, W_YANG_DOM 10→2, W_SHADOW_CLEAN 20→2, W_STAGE_GAIN 20 (unchanged), W_CRASH_AVOID 10→66` (sum 100).
- hypothesis: round 5 with marginal crash weight increase to push one more label-top-10 code into the wcmi top-10.
- spearman_rho: 0.7538
- overlap_top30: 0.667
- overlap_top10: 0.600
- false_negative_count: 0
- false_positive_count: 0
- observation: top-10 hit 0.60 ✓ but top-30 fell back below 0.70. The W_CRASH 60→66 step swapped one code in top-10 but bumped two codes out of top-30. Lift comes in discrete steps as ranks flip; need to find a config where the top-10 swap doesn't disturb mid-rank ordering.

## 2026-05-22 — round 7 (drop rhythm, restore tiny aesthetic, ease crash)
- diff vs default: `W_RHYTHM 10→0, W_MA_SUPPORT 15→3, W_UP_WAVE 15→3, W_YANG_DOM 10→3, W_SHADOW_CLEAN 20→3, W_STAGE_GAIN 20→28, W_CRASH_AVOID 10→60` (sum 100).
- hypothesis: rhythm's WCMI raw (`abs(corr - 0.15)`) is anti-correlated with label rhythm in the top tier (top label codes saturate label rhythm at 100 while having low raw rhythm percentile) — kill it. Restoring a small uniform aesthetic weight (3 each) gives the mid-rank codes a tiebreaker that lifts top-30 without disturbing the crash-driven top-10.
- spearman_rho: 0.8075
- overlap_top30: 0.767
- overlap_top10: 0.600
- false_negative_count: 0
- false_positive_count: 0
- observation: **all four convergence criteria met.** ρ=0.808, top-30=23/30=0.767, top-10=6/10=0.600, false_neg=0, false_pos=0. Final config: `W_RHYTHM=0, W_MA_SUPPORT=3, W_UP_WAVE=3, W_YANG_DOM=3, W_SHADOW_CLEAN=3, W_STAGE_GAIN=28, W_CRASH_AVOID=60` (sum 100). Thresholds untouched from default. Writing back to `WCMI_CONFIG`.

## 2026-05-22 — convergence verified (write-back)
- diff vs default: round-7 values now live in `WCMI_CONFIG` (`apps/api/src/modules/stock-meta/domain/pure/wcmi-subscores/types.ts`); `TUNING_CONFIG` in `scripts/wcmi-backtest.ts` is back to a plain `{ ...WCMI_CONFIG }` spread.
- spearman_rho: 0.8075
- overlap_top30: 0.767
- overlap_top10: 0.600
- false_negative_count: 0
- false_positive_count: 0
- observation: re-run reproduces round-7 metrics exactly. `pnpm --filter api exec tsc --noEmit` clean modulo the pre-existing `test/modules/instruction/instruction.im.listener.spec.ts:180` TS6133 warning. Top-10 manual K-line review (criterion 5) is the next step for the user.

