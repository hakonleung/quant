/**
 * Pure port of ``services/py/quant_core/domain/pure/derive_metrics.py``.
 *
 * Both implementations are kept in sync until the snapshot Flight op
 * (`list_stock_snapshots`) also migrates; Python still uses the original
 * for its fallback path, so any口径 change must land in both files.
 * The parity check lives in ``derive-metrics.parity.test.ts`` (planned
 * Phase 2 follow-up — see ``docs/perf/storage-unify-rollout.md``).
 *
 * Permissive on inputs: any missing field / non-positive denominator
 * propagates to ``null`` so the UI's "—" path stays correct.
 */

import type { QuarterlyFinancials, StockMetaDto } from '@quant/shared';

import { D, type Dec } from './decimal-config.js';

export interface DerivedMetrics {
  readonly mkt_cap: Dec | null;
  readonly float_mkt_cap: Dec | null;
  readonly pe_ttm: Dec | null;
  readonly pe_dynamic: Dec | null;
  readonly pb: Dec | null;
  readonly peg: Dec | null;
  readonly gross_margin_ttm: Dec | null;
}

const EMPTY: DerivedMetrics = {
  mkt_cap: null,
  float_mkt_cap: null,
  pe_ttm: null,
  pe_dynamic: null,
  pb: null,
  peg: null,
  gross_margin_ttm: null,
};

export function deriveMetrics(meta: StockMetaDto, price: Dec | null): DerivedMetrics {
  if (price === null || price.lte(0)) return EMPTY;

  const totalShare = parseOpt(meta.total_share);
  const floatShare = parseOpt(meta.float_share);
  const netAssets = parseOpt(meta.net_assets);

  const mktCap = mul(totalShare, price);
  const floatMktCap = mul(floatShare, price);

  const peTtm = safeDiv(mktCap, sumNetProfit(meta.quarterlies, -4, undefined));
  const peDynamic = peDynamicCompute(meta.quarterlies, mktCap);
  const pb = safeDiv(mktCap, netAssets);
  const peg = pegCompute(meta.quarterlies, peTtm);
  const grossMargin = grossMarginTtm(meta.quarterlies);

  return {
    mkt_cap: mktCap,
    float_mkt_cap: floatMktCap,
    pe_ttm: peTtm,
    pe_dynamic: peDynamic,
    pb,
    peg,
    gross_margin_ttm: grossMargin,
  };
}

function parseOpt(value: string | null): Dec | null {
  if (value === null) return null;
  return new D(value);
}

function mul(a: Dec | null, b: Dec | null): Dec | null {
  if (a === null || b === null) return null;
  if (a.lte(0) || b.lte(0)) return null;
  return a.mul(b);
}

function safeDiv(numerator: Dec | null, denominator: Dec | null): Dec | null {
  if (numerator === null || denominator === null) return null;
  if (denominator.lte(0)) return null;
  return numerator.div(denominator);
}

/**
 * Sum ``net_profit`` over a fixed-size slice of trailing quarters.
 *
 * Returns ``null`` when fewer than 4 quarters fall in the window or
 * any quarter is missing ``net_profit`` — same口径 as Py
 * ``_sum_net_profit``.
 */
function sumNetProfit(
  quarters: readonly QuarterlyFinancials[],
  start: number,
  stop: number | undefined,
): Dec | null {
  const chunk =
    stop === undefined ? sliceFromEnd(quarters, start) : sliceFromEnds(quarters, start, stop);
  if (chunk.length < 4) return null;
  let total = new D(0);
  for (const q of chunk) {
    if (q.net_profit === null) return null;
    total = total.add(new D(q.net_profit));
  }
  return total;
}

/** Mirrors Python's ``quarters[start:]`` for negative ``start``. */
function sliceFromEnd<T>(arr: readonly T[], start: number): readonly T[] {
  return arr.slice(start < 0 ? Math.max(0, arr.length + start) : start);
}

/** Mirrors Python's ``quarters[start:stop]`` for negative bounds. */
function sliceFromEnds<T>(arr: readonly T[], start: number, stop: number): readonly T[] {
  const s = start < 0 ? Math.max(0, arr.length + start) : start;
  const e = stop < 0 ? Math.max(0, arr.length + stop) : stop;
  return arr.slice(s, e);
}

/**
 * EastMoney-style 动态 PE.
 *
 * Annualises the latest quarter's net profit using ``net_profit *
 * 4 / quarter_index``, where ``quarter_index ∈ {1,2,3,4}`` is derived
 * from ``period`` (3→1, 6→2, 9→3, 12→4). The口径 is documented in
 * ``docs/modules/01-stock-meta.md`` §2.1 and §9.
 */
function peDynamicCompute(
  quarters: readonly QuarterlyFinancials[],
  mktCap: Dec | null,
): Dec | null {
  if (mktCap === null || quarters.length === 0) return null;
  const latest = quarters[quarters.length - 1]!;
  if (latest.net_profit === null) return null;
  const netProfit = new D(latest.net_profit);
  if (netProfit.lte(0)) return null;
  const qIdx = quarterIndex(latest.period);
  if (qIdx === null) return null;
  const annualised = netProfit.mul(4).div(qIdx);
  if (annualised.lte(0)) return null;
  return mktCap.div(annualised);
}

/**
 * PEG using TTM-vs-prior-TTM growth on net_profit. Needs ≥ 8 reporting
 * periods; fewer quarters / negative prior TTM / non-positive growth
 * propagate to ``null``.
 */
function pegCompute(quarters: readonly QuarterlyFinancials[], peTtm: Dec | null): Dec | null {
  if (peTtm === null || quarters.length < 8) return null;
  const recent = sumNetProfit(quarters, -4, undefined);
  const prior = sumNetProfit(quarters, -8, -4);
  if (recent === null || prior === null || prior.lte(0)) return null;
  const growthPct = recent.sub(prior).div(prior).mul(100);
  if (growthPct.lte(0)) return null;
  return peTtm.div(growthPct);
}

function grossMarginTtm(quarters: readonly QuarterlyFinancials[]): Dec | null {
  if (quarters.length < 4) return null;
  const chunk = quarters.slice(-4);
  let revTotal = new D(0);
  let costTotal = new D(0);
  for (const q of chunk) {
    if (q.revenue === null || q.operating_cost === null) return null;
    revTotal = revTotal.add(new D(q.revenue));
    costTotal = costTotal.add(new D(q.operating_cost));
  }
  if (revTotal.lte(0)) return null;
  return revTotal.sub(costTotal).div(revTotal);
}

function quarterIndex(period: string): number | null {
  // period is ISO YYYY-MM-DD; quarter end months are 3 / 6 / 9 / 12.
  const month = Number.parseInt(period.slice(5, 7), 10);
  switch (month) {
    case 3:
      return 1;
    case 6:
      return 2;
    case 9:
      return 3;
    case 12:
      return 4;
    default:
      return null;
  }
}
