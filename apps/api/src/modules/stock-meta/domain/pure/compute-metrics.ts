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
