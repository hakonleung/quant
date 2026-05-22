/**
 * Pure projector from `(StockMetaDto, BarLike[])` into the persisted
 * snapshot row that {@link LocalStockMetaWriterService.upsertMetrics}
 * writes to `data/stock_metas.parquet`.
 *
 * - `bars` is ascending by trade_date; `bars[-1]` is the latest.
 * - Empty `bars` yields a row with every metric null.
 * - Non-positive latest close → returns are null; the derived block
 *   still routes through `deriveMetrics` (which short-circuits to
 *   EMPTY when `price <= 0`).
 * - `wcmi` is computed by the dedicated scoring engine in
 *   `wcmi-scoring.ts`; see its docstring for the full formula.
 */

import type { StockMetaDto } from '@quant/shared';

import { D, type Dec } from './decimal-config.js';
import { deriveMetrics } from './derive-metrics.js';

export interface BarLike {
  readonly trade_date: string; // ISO YYYY-MM-DD
  readonly open_qfq: number;
  readonly high_qfq: number;
  readonly low_qfq: number;
  readonly close_qfq: number;
  /** Raw share volume (10k 股 for A-share). Used by the FOMO
   *  soft-penalty turnover guard — `0` is a safe default for fixtures
   *  that don't exercise that branch. */
  readonly volume: number;
  /** Daily turnover in 元 (akshare convention). Same guard as above. */
  readonly turnover: number;
  /** Pre-computed MAs from `KlineBar` (qfq close). `null` when the
   *  trailing window is shorter than the MA period. Consumed by the
   *  WCMI sub-score engine (see `wcmi-subscores/`). */
  readonly ma5: number | null;
  readonly ma10: number | null;
  readonly ma20: number | null;
  readonly ma60: number | null;
}

export interface StockMetrics {
  readonly code: string;
  readonly asof: string | null;
  readonly price: Dec | null;
  readonly ret_1d: Dec | null;
  readonly ret_5d: Dec | null;
  readonly ret_10d: Dec | null;
  readonly ret_20d: Dec | null;
  readonly ret_90d: Dec | null;
  readonly ret_250d: Dec | null;
  readonly mkt_cap: Dec | null;
  readonly float_mkt_cap: Dec | null;
  readonly pe_ttm: Dec | null;
  readonly pe_dynamic: Dec | null;
  readonly pb: Dec | null;
  readonly peg: Dec | null;
  readonly gross_margin_ttm: Dec | null;
  /** Wave-quality composite ∈ [0, 1000]. Computed only by the batch
   *  backfill (needs universe-wide percentile tables — see
   *  `wcmi-scoring.ts` + `StockMetricsBackfillService`). Per-code
   *  projection leaves this field `null`; the next batch pass fills
   *  it in. */
  readonly wcmi: Dec | null;
  /** Per-sub-score cross-sectional percentile × 100. All `null` when
   *  `wcmi` is null. */
  readonly wcmi_rhythm: Dec | null;
  readonly wcmi_ma_support: Dec | null;
  readonly wcmi_up_wave: Dec | null;
  readonly wcmi_yang_dom: Dec | null;
  readonly wcmi_shadow_clean: Dec | null;
  readonly wcmi_stage_gain: Dec | null;
  readonly wcmi_crash_avoid: Dec | null;
  readonly wcmi_recent_strength: Dec | null;
}

const RETURN_WINDOWS: readonly (readonly [keyof StockMetrics, number])[] = [
  ['ret_1d', 1],
  ['ret_5d', 5],
  ['ret_10d', 10],
  ['ret_20d', 20],
  ['ret_90d', 90],
  ['ret_250d', 250],
];

const EMPTY_RETURNS: Pick<
  StockMetrics,
  'ret_1d' | 'ret_5d' | 'ret_10d' | 'ret_20d' | 'ret_90d' | 'ret_250d'
> = {
  ret_1d: null,
  ret_5d: null,
  ret_10d: null,
  ret_20d: null,
  ret_90d: null,
  ret_250d: null,
};

export function computeMetrics(meta: StockMetaDto, bars: readonly BarLike[]): StockMetrics {
  if (bars.length === 0) {
    return {
      code: meta.code,
      asof: null,
      price: null,
      ...EMPTY_RETURNS,
      mkt_cap: null,
      float_mkt_cap: null,
      pe_ttm: null,
      pe_dynamic: null,
      pb: null,
      peg: null,
      gross_margin_ttm: null,
      wcmi: null,
      wcmi_rhythm: null,
      wcmi_ma_support: null,
      wcmi_up_wave: null,
      wcmi_yang_dom: null,
      wcmi_shadow_clean: null,
      wcmi_stage_gain: null,
      wcmi_crash_avoid: null,
      wcmi_recent_strength: null,
    };
  }
  const latest = bars[bars.length - 1]!;
  const latestClose = new D(latest.close_qfq);
  const derived = deriveMetrics(meta, latestClose);
  const returns = computeReturns(bars, latestClose);
  return {
    code: meta.code,
    asof: latest.trade_date,
    price: latestClose.gt(0) ? latestClose : null,
    ...returns,
    ...derived,
    // wcmi is universe-rank-based — only the batch backfill knows
    // every code's raw features and can compute percentiles.
    wcmi: null,
    wcmi_rhythm: null,
    wcmi_ma_support: null,
    wcmi_up_wave: null,
    wcmi_yang_dom: null,
    wcmi_shadow_clean: null,
    wcmi_stage_gain: null,
    wcmi_crash_avoid: null,
    wcmi_recent_strength: null,
  };
}

function computeReturns(
  bars: readonly BarLike[],
  latestClose: Dec,
): Pick<StockMetrics, 'ret_1d' | 'ret_5d' | 'ret_10d' | 'ret_20d' | 'ret_90d' | 'ret_250d'> {
  if (latestClose.lte(0)) return EMPTY_RETURNS;
  const out: Record<string, Dec | null> = { ...EMPTY_RETURNS };
  for (const [name, window] of RETURN_WINDOWS) {
    if (bars.length <= window) {
      out[name] = null;
      continue;
    }
    const baseClose = new D(bars[bars.length - 1 - window]!.close_qfq);
    if (baseClose.lte(0)) {
      out[name] = null;
      continue;
    }
    out[name] = latestClose.sub(baseClose).div(baseClose);
  }
  return out as Pick<
    StockMetrics,
    'ret_1d' | 'ret_5d' | 'ret_10d' | 'ret_20d' | 'ret_90d' | 'ret_250d'
  >;
}
