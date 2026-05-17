/**
 * Pure port of ``services/py/quant_core/domain/pure/compute_metrics.py``.
 *
 * Projects ``(StockMetaDto, BarLike[])`` into the persisted snapshot
 * row that {@link LocalStockMetaWriterService.upsertMetrics} writes to
 * ``data/stock_metas.parquet``.
 *
 * - ``bars`` is ascending by trade_date; ``bars[-1]`` is the latest.
 * - Empty ``bars`` yields a row with every metric null (matches Py).
 * - Non-positive latest close → returns are null but the derived block
 *   still goes through ``deriveMetrics`` for parity with the Py
 *   projector's behaviour (which calls derive with the negative close,
 *   landing in its own ``price <= 0 → EMPTY`` branch).
 */

import type { StockMetaDto } from '@quant/shared';

import { D, type Dec } from './decimal-config.js';
import { deriveMetrics } from './derive-metrics.js';

export interface BarLike {
  readonly trade_date: string; // ISO YYYY-MM-DD
  readonly close_qfq: number;
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
  /** Volatility-normalised Weighted Composite Momentum Index:
   *
   *  - σ_T = sample stddev of daily pct changes over the last T trading
   *    days (T ∈ {5, 10, 20, 90}).
   *  - R'_T = ret_T / σ_T  (cumulative period return rescaled by its
   *    own-window daily volatility).
   *  - wcmi = 2·R'_5 + 5·R'_10 + 4·R'_20 + 1·R'_90.
   *
   *  `null` when any stage return is `null`, or when any σ_T is `null`
   *  (insufficient history / non-positive baseline) or zero (the period
   *  had no movement → R'_T is undefined). */
  readonly wcmi: Dec | null;
}

const WCMI_WEIGHTS: readonly (readonly [
  'ret_5d' | 'ret_10d' | 'ret_20d' | 'ret_90d',
  number,
])[] = [
  ['ret_5d', 2],
  ['ret_10d', 5],
  ['ret_20d', 4],
  ['ret_90d', 1],
];

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
    };
  }
  const latest = bars[bars.length - 1]!;
  const latestClose = new D(latest.close_qfq);
  const derived = deriveMetrics(meta, latestClose);
  const returns = computeReturns(bars, latestClose);
  const dailyChanges = computeDailyPctChanges(bars);
  return {
    code: meta.code,
    asof: latest.trade_date,
    price: latestClose.gt(0) ? latestClose : null,
    ...returns,
    ...derived,
    wcmi: computeWcmi(returns, dailyChanges),
  };
}

/**
 * Daily pct change series, oldest first. `daily[i]` corresponds to the
 * return from `bars[i]` to `bars[i+1]`. Length is `bars.length - 1`.
 * Slots are `null` when the prior close is missing or non-positive.
 */
function computeDailyPctChanges(bars: readonly BarLike[]): readonly (Dec | null)[] {
  if (bars.length < 2) return [];
  const out: (Dec | null)[] = new Array(bars.length - 1);
  for (let i = 1; i < bars.length; i += 1) {
    const prev = new D(bars[i - 1]!.close_qfq);
    if (prev.lte(0)) {
      out[i - 1] = null;
      continue;
    }
    const cur = new D(bars[i]!.close_qfq);
    out[i - 1] = cur.sub(prev).div(prev);
  }
  return out;
}

/**
 * Sample stddev of the last `window` daily pct changes (Bessel-corrected,
 * divisor `window - 1`). Returns `null` when the tail does not have
 * `window` consecutive non-null entries, or when `window < 2`.
 */
function stddevDailyChanges(
  daily: readonly (Dec | null)[],
  window: number,
): Dec | null {
  if (window < 2 || daily.length < window) return null;
  const tail = daily.slice(daily.length - window);
  let sum = new D(0);
  for (const v of tail) {
    if (v === null) return null;
    sum = sum.add(v);
  }
  const mean = sum.div(window);
  let sq = new D(0);
  for (const v of tail) {
    const dv = v!.sub(mean);
    sq = sq.add(dv.mul(dv));
  }
  // Bessel-corrected sample variance — matches `numpy.std(..., ddof=1)`.
  return sq.div(window - 1).sqrt();
}

/**
 * Volatility-normalised composite momentum.
 *   wcmi = Σ weight_T · (ret_T / σ_T)
 * `null` when any stage return is null, or any σ_T is null / zero.
 */
function computeWcmi(
  returns: Pick<StockMetrics, 'ret_5d' | 'ret_10d' | 'ret_20d' | 'ret_90d'>,
  daily: readonly (Dec | null)[],
): Dec | null {
  let acc = new D(0);
  for (const [key, weight] of WCMI_WEIGHTS) {
    const ret = returns[key];
    if (ret === null) return null;
    const window = STAGE_WINDOWS[key];
    const sigma = stddevDailyChanges(daily, window);
    if (sigma === null || sigma.lte(0)) return null;
    acc = acc.add(ret.div(sigma).mul(weight));
  }
  return acc;
}

const STAGE_WINDOWS: Readonly<Record<'ret_5d' | 'ret_10d' | 'ret_20d' | 'ret_90d', number>> = {
  ret_5d: 5,
  ret_10d: 10,
  ret_20d: 20,
  ret_90d: 90,
};

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
