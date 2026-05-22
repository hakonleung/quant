/**
 * WCMI v2 — 90-day wave-quality scoring engine. Top-level barrel for the
 * `wcmi-subscores/` directory.
 *
 *   Phase A  extractWcmiSubscores(bars, config)  → WcmiSubscores | null
 *   Phase B  scoreUniverse(items, config)         → Map<code, WcmiScore | null>
 *
 * Sub-scores are computed over the trailing `config.WINDOW` bars (default
 * 90). Each is cross-sectionally percentile-ranked across survivors, then
 * weight-combined into a composite in `[0, WCMI_TOTAL_SCALE]`. Codes with
 * `bars.length < 30` or `r_window <= 0` receive `null`.
 *
 * Full design + per-sub-score formulas: `docs/perf/wcmi-redesign.md`.
 */

export type {
  WcmiConfig,
  WcmiSubscores,
  WcmiPctBreakdown,
  WcmiScore,
  ScoringInput,
} from './wcmi-subscores/types.js';
export { WCMI_CONFIG } from './wcmi-subscores/types.js';
export { extractWcmiSubscores } from './wcmi-subscores/extract.js';
export { extractWcmiSubscoreDetail } from './wcmi-subscores/detail.js';
export type { WcmiSubscoreDetail } from './wcmi-subscores/detail.js';
export { scoreUniverse } from './wcmi-subscores/score-universe.js';
export { percentileNorm } from './wcmi-subscores/utils.js';
