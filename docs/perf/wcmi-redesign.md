# WCMI Redesign — 90-Day Wave-Quality Scoring

**Date:** 2026-05-22
**Status:** design — awaiting implementation

---

## Background

The current implementation (`apps/api/src/modules/stock-meta/domain/pure/wcmi-scoring.ts`, ~895 lines) scores A-share stocks across four modules:

- **S_mom** — multi-window return ranks (r5/r10/r20/r60/r90) with a "breakout bonus"
- **S_exp** — holding-experience signal (kform counts, shadow counts, continuity, drawdown, big-down, low-open) over a fixed 30-bar lookback
- **S_timing** — absolute proximity-to-MA scoring + last-day anomaly penalty
- **P_fomo** — absolute overbought / no-volume / limit-up penalty

The lookback for S_exp count features is hardcoded at 30 bars. S_mom is multi-window but makes no distinction between a smooth trend and a one-shot spike with the same total return. Output is a signed score in `[-1000, +1000]`.

**Why redesign.** The user specified five explicit goals that the current design does not model:

1. **Regular wave / rhythm** — price action must show recognizable swing structure (autocorrelation of returns, local peak-trough spacing, periodicity quality), not one-shot moves or straight-line drift.
2. **Aesthetic K-line shape**, decomposed into:
   - MA support: close consistently above ma20/ma60; ma5>ma10>ma20>ma60 alignment frequency; mean distance above ma20.
   - Up-wave continuity and smoothness: long runs of consecutive yang candles (including 假阳 = close>open); low intra-wave drawdown; steady rising-segment slope.
   - Yang candle dominance: ratio of yang (close > open) to total candles in window.
   - Few long upper shadows: upper_shadow = high − max(open,close); penalise per-bar when ratio to body or range is large, especially on up-days.
3. **Large stage gain** — total return over the window, with preference for the high being recent (recency score).
4. **Few large crash days** — single-day drops < −7%, count and magnitude; also gap-down opens that don't recover.
5. **Unified 90-bar sampling window** — all sub-scores computed over the same configurable trailing window (default = 90 trading days).

The redesign replaces all four current modules with seven sub-scores computed on a single window. The cross-sectional percentile architecture and batch-backfill pipeline shape are preserved exactly. Output changes from `[-1000, +1000]` to `[0, 1000]` (fully non-negative; median stock = 500).

---

## Sampling Window

**Default:** `WINDOW = 90` trading bars, configurable via `WCMI_CONFIG.WINDOW`.

All sub-scores are computed exclusively over `bars.slice(-WINDOW)` (i.e. the last `min(WINDOW, bars.length)` bars). Stage gain is measured from `bars[-WINDOW].close_qfq` to `bars[-1].close_qfq`.

**Edge cases:**

- `bars.length < 30` → `extractWcmiSubscores` returns `null`. Code is excluded from rank tables; gets `wcmi = null` in the parquet.
- `30 ≤ bars.length < WINDOW` → use all available bars as the window. Sub-scores compute on the shorter history; stage_gain is measured from `bars[0]`. These are "fallback" codes — they receive a score and participate in ranking but with higher noise. An optional `wcmi_window_len` DTO field documents the actual window used (see §Open Questions #1).

---

## Sub-Score Formal Definitions

All percentage changes are normalised relative to `prevClose` (previous bar's `close_qfq`), matching the convention in the existing `computeBarMetrics`. `BarLike` must be extended to include `ma5 / ma10 / ma20 / ma60: number | null` — these are already present on `KlineBar` in `packages/shared/src/types/eqty.ts` and already passed through kline parquet; the `toBarLike` adapters just need to map them.

---

### 1. `rhythm` — Wave regularity

**Goal:** reward recognizable, repeating swings; penalise one-shot rockets and featureless drift.

Let `returns[i] = (close[i] − close[i−1]) / close[i−1]` for `i ∈ [1, N−1]` inside window W of N bars.

```
lag1_autocorr = PearsonCorr(returns[1..N−2], returns[2..N−1])
raw_autocorr_score = −|lag1_autocorr − RHYTHM_TARGET|
  where RHYTHM_TARGET = 0.15   (mild positive momentum = "wave-like")

peak_count   = count of i where close[i] > close[i−1] AND close[i] > close[i+1]
trough_count = count of i where close[i] < close[i−1] AND close[i] < close[i+1]
swing_count  = min(peak_count, trough_count)
swing_density = swing_count / (N / SWING_PERIOD_BARS)   where SWING_PERIOD_BARS = 15

rhythm_raw = 0.6 × clip(raw_autocorr_score / 0.5, −1, 1)
           + 0.4 × clip(swing_density, 0, 2) − 1
```

**Inputs:** `close_qfq[]`.
**Raw range:** approximately `[−1.6, 0.6]`. Higher is better.
**Direction for rank:** higher → better (no flip).
**Normalization:** cross-sectional percentile across survivors per date → `pct_rhythm ∈ [0, 1]`.

---

### 2. `ma_support` — MA support strength

**Goal:** close consistently above ma20/ma60; all four MAs bullishly aligned.

```
above_ma20_rate = count(close[i] > ma20[i]) / N_valid_ma20
above_ma60_rate = count(close[i] > ma60[i]) / N_valid_ma60
alignment_rate  = count(ma5[i] > ma10[i] > ma20[i] > ma60[i]) / N_valid_all4
mean_dist_ma20  = mean((close[i] − ma20[i]) / ma20[i]) for bars where ma20[i] > 0

ma_support_raw =  0.35 × above_ma20_rate
               +  0.20 × above_ma60_rate
               +  0.30 × alignment_rate
               +  0.15 × clip(mean_dist_ma20 / 0.15, −1, +1)
```

The `/ 0.15` normalises so a mean distance of +15% above ma20 scores the dimension's maximum.

**Inputs:** `close_qfq, ma5, ma10, ma20, ma60` per bar.
**Raw range:** approximately `[−0.15, 1.0]`. Higher is better.
**Direction for rank:** higher → better.
**Normalization:** cross-sectional percentile → `pct_ma_support ∈ [0, 1]`.

---

### 3. `up_wave_smoothness` — Up-swing continuity and slope steadiness

**Goal:** long runs of yang candles in advancing segments; low intra-swing drawdown; steady slope.

**Yang definition (inclusive of 假阳):** bar `i` is yang if `close[i] > open[i]`.

```
yang_run_lengths[] = lengths of all maximal consecutive-yang runs in W
max_yang_run  = max(yang_run_lengths)   (0 if no yang bars)
mean_yang_run = mean(yang_run_lengths)  (0 if none)
```

For each up-swing segment (maximal sub-sequence where each close ≥ prior close):
```
intra_swing_drawdown = (peak − trough) / peak  for peak/trough within the segment
mean_swing_dd = mean(intra_swing_drawdown) across all segments  (0 if none)
```

For each up-swing of ≥ 5 bars, fit OLS of `close_qfq` on `bar_index`; record `R²`:
```
mean_slope_r2 = mean(R² values)   (default 0.5 if no qualifying segments)
```

```
up_wave_smoothness_raw =
    0.35 × clip(max_yang_run / 8, 0, 1)
  + 0.25 × clip(mean_yang_run / 4, 0, 1)
  + 0.25 × (1 − clip(mean_swing_dd / 0.05, 0, 1))
  + 0.15 × mean_slope_r2
```

**Inputs:** `open_qfq, close_qfq` per bar.
**Raw range:** `[0, 1]`. Higher is better.
**Direction for rank:** higher → better.
**Normalization:** cross-sectional percentile → `pct_up_wave ∈ [0, 1]`.

---

### 4. `yang_dominance` — Yang candle ratio

**Goal:** most candles are yang (close > open), capturing broad buying-pressure dominance.

```
yang_dominance_raw = count(close[i] > open[i]) / N
```

**Inputs:** `open_qfq, close_qfq`.
**Raw range:** `[0, 1]`. Higher is better.
**Direction for rank:** higher → better.
**Normalization:** cross-sectional percentile → `pct_yang_dom ∈ [0, 1]`.

---

### 5. `upper_shadow_clean` — Absence of large upper shadows

**Goal:** penalise per-bar upper-shadow rejection, especially on yang days.

```
upper_shadow[i] = max(high[i] − max(open[i], close[i]), 0) / prevClose[i] × 100   (%)
body[i]         = |close[i] − open[i]| / prevClose[i] × 100   (%)
range[i]        = (high[i] − low[i]) / prevClose[i] × 100   (%)

shadow_body_ratio[i]  = upper_shadow[i] / max(body[i], 0.5)
shadow_range_ratio[i] = upper_shadow[i] / max(range[i], 0.5)

penalty[i] = 0.5 × clip(shadow_body_ratio[i] / SHADOW_BODY_THR, 0, 1)
           + 0.5 × clip(shadow_range_ratio[i] / SHADOW_RANGE_THR, 0, 1)
  where SHADOW_BODY_THR = 1.5,  SHADOW_RANGE_THR = 0.4

weight[i] = 1.5 if (close[i] > open[i]) else 1.0

upper_shadow_clean_raw = 1 − Σ(penalty[i] × weight[i]) / Σ(weight[i])
```

**Inputs:** `open_qfq, high_qfq, low_qfq, close_qfq`; `prevClose` from prior bar.
**Raw range:** approximately `[0, 1]`. Higher (lower penalties) is better.
**Direction for rank:** higher → better.
**Normalization:** cross-sectional percentile → `pct_shadow_clean ∈ [0, 1]`.

---

### 6. `stage_gain` — Total window return with recency preference

**Goal:** large absolute gain; bonus for the window's high occurring recently.

```
r_window    = (close[-1] − close[-WINDOW]) / close[-WINDOW] × 100   (%)
range_gain  = (close[-1] − window_low) / window_low × 100   (%)
              where window_low = min(low_qfq[i]) for i in W, window_low > 0

recency_idx   = argmax(close_qfq[i]) for i in W
recency_score = recency_idx / (N − 1)   (0 = high at start, 1 = high at end)

stage_gain_raw = 0.5 × r_window + 0.3 × range_gain + 20 × recency_score
```

The `20 × recency_score` bias shifts stocks making new highs near the end of the window to rank above stocks with equal r_window but earlier highs.

**Inputs:** `close_qfq, low_qfq, high_qfq` per bar in W.
**Raw range:** approximately `(−50, +220)`. Higher is better.
**Survivor gate:** codes with `r_window ≤ 0` are excluded from rank tables (get `wcmi = null`). This replaces the current `r10 ≤ 0` gate.
**Direction for rank:** higher → better.
**Normalization:** cross-sectional percentile → `pct_stage_gain ∈ [0, 1]`.

---

### 7. `crash_avoidance` — Penalise single-day crashes and gap-down non-recoveries

**Goal:** filter stocks with frequent large drops or unrecovered gap-downs.

```
change[i]   = (close[i] − prevClose[i]) / prevClose[i] × 100   (%)
gap[i]      = (open[i]  − prevClose[i]) / prevClose[i] × 100   (%)
yang[i]     = close[i] > open[i]

crash_days    = count(change[i] < −CRASH_DAY_THR)    where CRASH_DAY_THR = 7 (%)
gap_down_days = count(gap[i] < GAP_DOWN_THR AND NOT yang[i])
                where GAP_DOWN_THR = −2 (%)
crash_severity = mean(|change[i]| for bars where change[i] < −CRASH_DAY_THR)
                 (0 if no crash days)

crash_avoidance_raw =
    1
  − 0.5 × clip(crash_days / CRASH_COUNT_CAP, 0, 1)            CRASH_COUNT_CAP = 4
  − 0.3 × clip((crash_severity − CRASH_DAY_THR) / 5, 0, 1)   excess severity over 7% / 5%
  − 0.2 × clip(gap_down_days / GAP_DOWN_CAP, 0, 1)            GAP_DOWN_CAP = 6
```

**Inputs:** `open_qfq, close_qfq`; `prevClose` from prior bar.
**Raw range:** `[−0.5, 1.0]`. Higher is better.
**Direction for rank:** higher → better.
**Normalization:** cross-sectional percentile → `pct_crash_avoid ∈ [0, 1]`.

---

## Composite Formula

Each sub-score's cross-sectional percentile `pct_k ∈ [0, 1]` is combined as:

```
WCMI = (WCMI_TOTAL_SCALE / Σ_k w_k) × Σ_k (w_k × pct_k)
```

With default `WCMI_TOTAL_SCALE = 1000` and weights below, `SCALE = 1000 / 100 = 10`. Output is `[0, 1000]`; median stock = 500.

| Sub-score             | Weight | Rationale                                                           |
|-----------------------|--------|---------------------------------------------------------------------|
| `rhythm`              | 10     | wave structure rules out one-shot spikes and featureless drift       |
| `ma_support`          | 15     | most reliable visual signal of sustained trend quality               |
| `up_wave_smoothness`  | 15     | consecutive yang runs and slope steadiness match the aesthetic goal  |
| `yang_dominance`      | 10     | simple and robust; captures distinct variance from smoothness        |
| `upper_shadow_clean`  | 20     | upper shadows are the user's highest-priority aesthetic complaint     |
| `stage_gain`          | 20     | screening for stocks going up is the primary purpose                 |
| `crash_avoidance`     | 10     | filters "up but volatile"; smoothness partly overlaps, hence lower weight |

Sum = 100, SCALE = 10.

**Survivor gate:** codes with `r_window ≤ 0` receive `wcmi = null` and are excluded from all rank tables.

---

## Public API

Module path: `apps/api/src/modules/stock-meta/domain/pure/wcmi-scoring.ts` (full replacement).

If the file exceeds 400 lines, extract per-sub-score helpers into `wcmi-subscores/` under the same directory, re-exporting from `wcmi-scoring.ts`.

**Extended `BarLike`** (in `compute-metrics.ts`):

```typescript
export interface BarLike {
  readonly trade_date: string;
  readonly open_qfq: number;
  readonly high_qfq: number;
  readonly low_qfq: number;
  readonly close_qfq: number;
  readonly volume: number;
  readonly turnover: number;
  readonly ma5: number | null;    // pre-computed at kline ingest
  readonly ma10: number | null;
  readonly ma20: number | null;
  readonly ma60: number | null;
}
```

**`WcmiConfig`:**

```typescript
export interface WcmiConfig {
  readonly WINDOW: number;             // default 90
  readonly RHYTHM_TARGET: number;      // default 0.15
  readonly SWING_PERIOD_BARS: number;  // default 15
  readonly SHADOW_BODY_THR: number;    // default 1.5
  readonly SHADOW_RANGE_THR: number;   // default 0.4
  readonly CRASH_DAY_THR: number;      // default 7
  readonly CRASH_COUNT_CAP: number;    // default 4
  readonly GAP_DOWN_THR: number;       // default -2
  readonly GAP_DOWN_CAP: number;       // default 6
  readonly W_RHYTHM: number;           // default 10
  readonly W_MA_SUPPORT: number;       // default 15
  readonly W_UP_WAVE: number;          // default 15
  readonly W_YANG_DOM: number;         // default 10
  readonly W_SHADOW_CLEAN: number;     // default 20
  readonly W_STAGE_GAIN: number;       // default 20
  readonly W_CRASH_AVOID: number;      // default 10
  readonly WCMI_TOTAL_SCALE: number;   // default 1000
}

export const WCMI_CONFIG: WcmiConfig = { /* defaults above */ } as const;
```

**Per-code raw subscores:**

```typescript
export interface WcmiSubscores {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
  readonly windowLen: number;      // actual bars used
  readonly passesGate: boolean;    // false when r_window <= 0
}
```

**Per-code scored output (returned by `scoreUniverse`):**

```typescript
export interface WcmiScore {
  readonly composite: number;   // ∈ [0, WCMI_TOTAL_SCALE]
  readonly pct: {
    readonly rhythm: number;          // ∈ [0, 1]
    readonly maSupport: number;
    readonly upWaveSmoothness: number;
    readonly yangDominance: number;
    readonly upperShadowClean: number;
    readonly stageGain: number;
    readonly crashAvoidance: number;
  };
}
```

**Exported functions:**

```typescript
// Phase A — per code, O(WINDOW)
export function extractWcmiSubscores(
  bars: readonly BarLike[],
  config: WcmiConfig,
): WcmiSubscores | null;
// null iff bars.length < 30

// Phase B — universe-wide, O(N log N) per sub-score dimension
export interface ScoringInput {
  readonly code: string;
  readonly raw: WcmiSubscores;
}

export function scoreUniverse(
  items: readonly ScoringInput[],
  config: WcmiConfig,
): Map<string, WcmiScore | null>;
// null for gate-failed or missing codes

// Exposed for tests
export function percentileNorm(
  sorted: readonly number[],
  value: number,
): number;   // → [0, 1], average-rank tie-breaking
```

---

## DTO Changes

**`packages/shared/src/types/stock-meta.ts`** — update `StockDerivedMetricsSchema`:

```typescript
export const StockDerivedMetricsSchema = z.object({
  mkt_cap: decimalStringOrNull,
  float_mkt_cap: decimalStringOrNull,
  pe_ttm: decimalStringOrNull,
  pe_dynamic: decimalStringOrNull,
  pb: decimalStringOrNull,
  peg: decimalStringOrNull,
  gross_margin_ttm: decimalStringOrNull,
  /** WCMI composite ∈ [0, 1000]. null when < 30 bars or net-down window. */
  wcmi: decimalStringOrNull,
  wcmi_rhythm: decimalStringOrNull,
  wcmi_ma_support: decimalStringOrNull,
  wcmi_up_wave: decimalStringOrNull,
  wcmi_yang_dom: decimalStringOrNull,
  wcmi_shadow_clean: decimalStringOrNull,
  wcmi_stage_gain: decimalStringOrNull,
  wcmi_crash_avoid: decimalStringOrNull,
}).strict();
```

Each `wcmi_*` field is the per-code percentile rank for that dimension multiplied by 100, stored as a decimal string (so `"73.40"` means 73rd percentile). All are `null` when `wcmi` is null.

**`StockMetrics`** (`compute-metrics.ts`):

```typescript
export interface StockMetrics {
  // ... existing fields unchanged ...
  readonly wcmi: Dec | null;
  readonly wcmi_rhythm: Dec | null;
  readonly wcmi_ma_support: Dec | null;
  readonly wcmi_up_wave: Dec | null;
  readonly wcmi_yang_dom: Dec | null;
  readonly wcmi_shadow_clean: Dec | null;
  readonly wcmi_stage_gain: Dec | null;
  readonly wcmi_crash_avoid: Dec | null;
}
```

**`StockMetricsRow`** (`local-stock-meta-writer.service.ts`):

Add 7 `string | null` fields to the interface and extend `METRIC_DECIMAL_COLUMNS` with the 7 column names (`'wcmi_rhythm'`, `'wcmi_ma_support'`, `'wcmi_up_wave'`, `'wcmi_yang_dom'`, `'wcmi_shadow_clean'`, `'wcmi_stage_gain'`, `'wcmi_crash_avoid'`). The existing `ensureSchema` / `runEnsureSchema` mechanism automatically adds missing VARCHAR columns to the parquet on the first write after deployment — no separate migration script needed.

---

## Pipeline Impact

### `stock-metrics-backfill.service.ts`

Replace `extractRawFeatures` / `scoreUniverse` imports with the new `extractWcmiSubscores` / `scoreUniverse`. The `CodeContext.raw` field type changes from `WcmiRawFeatures | null` to `WcmiSubscores | null`. `scoreUniverse` now returns `Map<string, WcmiScore | null>` instead of `Map<string, number | null>`. The backfill passes `WcmiScore | null` to `toRowWithWcmi`.

`TAIL_BARS` stays at 280 (covers 90-bar window + safety margin).
`UPSERT_BATCH_SIZE` stays at 500.

### `stock-metrics-compute.service.ts`

`toRowWithWcmi` signature changes from `(meta, bars, wcmiScore: number | null)` to `(meta, bars, wcmiScore: WcmiScore | null)`. All fields from `WcmiScore.pct` are serialised to decimal strings in the row. `formatWcmiScore` helper is reused for the composite; the pct sub-scores are serialised with the same 2-decimal `toFixed(2)` strategy multiplied by 100 (i.e. `(pct * 100).toFixed(2)`).

### `local-stock-meta-writer.service.ts`

- `METRIC_DECIMAL_COLUMNS` grows by 7 entries.
- `StockMetricsRow` grows by 7 fields.
- `rowToValues` method grows by 7 `quoteOptionalString(row.wcmi_*)` calls (must match `METRIC_DECIMAL_COLUMNS` positional order exactly).
- The `buildMetricsCopySql` `overlaySql` is generated from `METRIC_DECIMAL_COLUMNS` via the existing loop — no hand-edits needed there.

---

## File List

| File | Change |
|------|--------|
| `apps/api/src/modules/stock-meta/domain/pure/wcmi-scoring.ts` | Full replacement — new 7-sub-score engine (~300–400 lines) |
| `apps/api/src/modules/stock-meta/domain/pure/compute-metrics.ts` | Add `ma5/ma10/ma20/ma60` to `BarLike`; add 7 sub-score nullable fields to `StockMetrics` |
| `apps/api/src/modules/stock-meta/stock-metrics-compute.service.ts` | `toBarLike` maps MA fields; `toRowWithWcmi` accepts `WcmiScore | null` |
| `apps/api/src/modules/stock-meta/stock-metrics-backfill.service.ts` | Import new API; use `WcmiScore` through pipeline |
| `apps/api/src/modules/stock-meta/local-stock-meta-writer.service.ts` | `METRIC_DECIMAL_COLUMNS` + `StockMetricsRow` + `rowToValues` gain 7 sub-score columns |
| `packages/shared/src/types/stock-meta.ts` | `StockDerivedMetricsSchema` gains 7 `wcmi_*` nullable fields |
| `apps/api/test/modules/stock-meta/wcmi-scoring.spec.ts` | Unit tests for each sub-score extractor + `scoreUniverse` |
| `docs/perf/wcmi-redesign.md` | This file |

If `wcmi-scoring.ts` approaches 400 lines, extract into `wcmi-subscores/` subdirectory with one file per sub-score.

---

## Test Strategy

All tests are pure unit tests — zero mocks, zero fixtures beyond fabricated `BarLike[]` arrays.

| Module | Test type | Coverage target |
|--------|-----------|----------------|
| Each `computeX` sub-score helper | unit | golden path + edge (all-yang, no yang, all-null MA, N=30, N=90, window high at start vs end) |
| `extractWcmiSubscores` | unit | null when bars.length < 30; passesGate=false when r_window ≤ 0; all 7 fields populated |
| `scoreUniverse` | unit | empty universe; single-stock universe; gate-failed codes get null; composite ∈ [0, 1000]; pct fields ∈ [0,1] |
| `percentileNorm` | unit | monotone; handles ties (average rank); handles N=1 |
| Backfill integration | integration (spec.ts) | verify 7 sub-score columns written to `StockMetricsRow`; verify null propagation for short-history codes |

---

## Open Questions / Parameters to Tune

1. **Short-history fallback confidence.** Should codes with `30 ≤ bars < 90` have their composite down-weighted by `bars/90` before ranking, or rank as-is on the shorter window? Recommendation: rank as-is but add a `wcmi_window_len` column to `StockMetricsRow` / DTO so the FE can display a "thin history" indicator. Decision needed before implementation.

2. **Rhythm `RHYTHM_TARGET = 0.15`.** Empirically validate on a sample of A-share kline parquet. If the actual distribution of lag-1 autocorrelation across the universe has a different mode, adjust. This is a tune-later parameter — the architecture is unchanged.

3. **Gate threshold.** Currently `r_window > 0`. Should there be a floor (e.g. `> 3%`) to also exclude barely-positive stocks? Recommend starting at `> 0` and tightening based on score distribution in the first backfill run.

4. **Output range change `[-1000, +1000]` → `[0, 1000]`.** Any FE code that treats negative WCMI specially (e.g. red colouring in `list-cells.tsx`) must be updated in the same PR. Verify with `apps/web/components/feat-eq-list/`.

5. **`KlineBar` MA fields already present.** Confirmed in `packages/shared/src/types/eqty.ts` lines 37–40 — `ma5/ma10/ma20/ma60` are on `KlineBar`. The `toBarLike` adapters in both compute and backfill services currently do not forward them; that omission must be fixed.

---

## 自评与调优流程

### 回测样本构建

从本地 kline 缓存 `data/kline/*.parquet` 取"最近 60 个交易日涨幅最大"的 100 只股票作为调优样本集。

**DuckDB 伪代码（脚本入口见下方）：**

```sql
-- Step 1: 每只股票取最近 61 条（60 个 change 需要 61 个点）
WITH ranked AS (
  SELECT
    code,
    ts,
    close_qfq,
    ROW_NUMBER() OVER (PARTITION BY code ORDER BY ts DESC) AS rn
  FROM read_parquet('data/kline/*.parquet')
),
latest AS (
  SELECT code, close_qfq AS close_now
  FROM ranked
  WHERE rn = 1
),
base60 AS (
  SELECT code, close_qfq AS close_60d_ago
  FROM ranked
  WHERE rn = 61          -- 61st-most-recent row = 60 trading days ago
),
gain AS (
  SELECT
    l.code,
    (l.close_now / b.close_60d_ago - 1) * 100 AS gain_60d_pct
  FROM latest l
  JOIN base60 b ON b.code = l.code
  WHERE b.close_60d_ago > 0
)
SELECT code, gain_60d_pct
FROM gain
ORDER BY gain_60d_pct DESC
LIMIT 100;
```

**约束：** 只取 `rn = 61` 存在的 code（即本地 kline 至少有 61 条），排除历史不足的次新股。样本集记录为 `wcmiBacktestSample: string[]`（100 个 code）。

---

### 自评打分

对样本集每只股票，按四条目标各自给出 0–100 的规则分作为 label，再运行新 WCMI 评分，对比二者分布。

**规则 label 定义（可在脚本内自动计算，无需人工逐一打分）：**

| Dimension | Label 计算规则（基于 90-bar 窗口） |
|---|---|
| `label_rhythm` | `swing_density ∈ [0,2]` 映射到 `[0,100]`，再加 `lag1_autocorr ∈ [0,0.3]` 的线性奖励（超出 0.3 截平）。即: `min(swing_density/2, 1)×70 + min(lag1_autocorr/0.3, 1)×30` |
| `label_aesthetic` | 四个子维度原始值的等权平均：`(ma_support_raw/1.0 + up_wave_smoothness_raw + yang_dominance_raw + upper_shadow_clean_raw) / 4 × 100` |
| `label_stage_gain` | `clip(r_window / 80, 0, 1) × 100`（80% 90-day 涨幅对应满分）|
| `label_crash_avoid` | `crash_avoidance_raw` 直接映射 `[−0.5, 1.0] → [0, 100]`：`(crash_avoidance_raw + 0.5) / 1.5 × 100` |

```typescript
// 复合 label = 与 WCMI 权重对齐的加权平均
const labelComposite =
  0.10 * label_rhythm
  + 0.45 * label_aesthetic   // ma_support+up_wave+yang_dom+shadow_clean 合并
  + 0.20 * label_stage_gain
  + 0.10 * label_crash_avoid;
// 注：label_aesthetic 权重 = W_MA_SUPPORT+W_UP_WAVE+W_YANG_DOM+W_SHADOW_CLEAN = 60，
//     但此处归一到 [0,100]，故系数 0.60；整体乘以 100/Σ = 1.
```

**评估指标：**

1. **Spearman 秩相关** — `spearman(labelComposite_rank, wcmiComposite_rank)` over 100 samples. 目标 ≥ 0.70.
2. **Top-K 命中率** — `|Top30_label ∩ Top30_wcmi| / 30`. 目标 ≥ 0.70. 同理 K=10 目标 ≥ 0.60.
3. **不一致样本清单** — 打印两类：
   - `label_rank ≤ 15 AND wcmi_rank > 50`（label 高但模型低，潜在漏报）
   - `label_rank > 70 AND wcmi_rank ≤ 15`（label 低但模型高，潜在误报）

脚本打印每只不一致股票的全部 7 个原始子分值以辅助诊断。

---

### 调优终止条件

满足以下全部条件时停止迭代：

1. **Top-30 重合 ≥ 70%**：`|Top30_label ∩ Top30_wcmi| ≥ 21`
2. **Top-10 全部通过目检**：对 `wcmi_rank ≤ 10` 的 10 只股票，人工打开 K 线图逐一确认"波形符合四条目标"，零反例。
3. **Spearman ρ ≥ 0.70**
4. **无"高优先级不一致"**：`label_rank ≤ 10 AND wcmi_rank > 40` 的 code 数 = 0

每轮迭代记录 `(权重组合, Spearman, Top-30 hit, Top-10 pass/fail)` 于 `docs/perf/wcmi-redesign-backtest.md` 的 changelog，保留全部历史以供回溯。

---

### 脚本入口

**文件路径：** `apps/api/scripts/wcmi-backtest.ts`

脚本用 `@duckdb/node-api` 直读 `data/kline/*.parquet`，不经过 NestJS 服务层和 Arrow Flight RPC（CLAUDE.md §2.1：读盘允许，写盘由 NestJS 负责）。

```typescript
// apps/api/scripts/wcmi-backtest.ts
// 用法：pnpm --filter @quant/api tsx scripts/wcmi-backtest.ts [--top=100] [--window=90]
//
// 输出：
//   1. 回测样本 code 列表（100 只，按 60d 涨幅降序）
//   2. 每只股票的 7 个 WCMI 子分 + 复合分 + label 复合分 + 秩
//   3. Spearman ρ，Top-30/Top-10 命中率
//   4. 不一致样本清单（label 高/模型高 各方向）

import { DuckDBInstance } from '@duckdb/node-api';
import { resolve } from 'node:path';
import {
  WCMI_CONFIG,
  extractWcmiSubscores,
  scoreUniverse,
} from '../src/modules/stock-meta/domain/pure/wcmi-scoring.js';
// ... (implementation by task #2 implementer)
```

脚本必须满足：

- 无 NestJS `@Injectable` 装饰器，无 DI 容器，无 HTTP 请求。
- `data/kline/*.parquet` 路径相对于 `process.cwd()`（即仓库根）。
- 直接 import `WCMI_CONFIG` 和纯函数，便于调参时修改常量后立即重跑。
- 最终输出 JSON 到 `docs/perf/data/wcmi-backtest-<YYYYMMDD>.json`（如目录不存在则创建），同时打印汇总到 stdout 便于管道到 `jq` 过滤。

---

### 参数回写规约

调优迭代收敛后，最终确定的权重和阈值**必须写回** `apps/api/src/modules/stock-meta/domain/pure/wcmi-scoring.ts` 中的 `WCMI_CONFIG` 常量，而不是只留在脚本的注释或临时变量中。

具体流程：

1. 在脚本顶部维护一个 `TUNING_CONFIG` 覆盖对象，迭代期间改这里：

   ```typescript
   // 调优实验用——收敛后把最终值 copy 回 WCMI_CONFIG
   const TUNING_CONFIG = {
     ...WCMI_CONFIG,
     W_SHADOW_CLEAN: 25,   // 实验值
     W_STAGE_GAIN: 18,     // 实验值
   };
   ```

2. 收敛后以 `refactor(wcmi): tune default weights to v2` 提交，直接改 `WCMI_CONFIG` 默认值，删除 `TUNING_CONFIG` 临时覆盖。

3. 提交信息正文写本次调优的量化结果：Spearman ρ、Top-30 hit、Top-10 通过情况。
