/**
 * Pure derivations from a list of K-line bars.
 *
 * The chart panel renders the full bar series; the list panel only
 * needs a few scalar projections per stock — this module is the single
 * source of truth so server- and client-side renderers stay aligned.
 *
 * All inputs are immutable; functions are total (no throws).
 */

import type { KlineBar } from '@quant/shared';

export interface StockStats {
  readonly price: number;
  /** Day-over-day close change as a fraction (0.0123 → +1.23%). */
  readonly chgPct: number | null;
  /** Latest bar's `turnoverRate` (`成交额 / 流通市值`). */
  readonly turnoverRate: number | null;
  /** Latest bar's `turnover` (CNY notional). */
  readonly turnover: number | null;
  /** Number of consecutive trailing bars where close > previous close. */
  readonly consecUpDays: number;
}

const EMPTY: StockStats = {
  price: 0,
  chgPct: null,
  turnoverRate: null,
  turnover: null,
  consecUpDays: 0,
};

export function deriveStats(bars: readonly KlineBar[]): StockStats {
  if (bars.length === 0) return EMPTY;
  const last = bars[bars.length - 1]!;
  const prev = bars.length >= 2 ? bars[bars.length - 2]! : null;
  const chgPct = prev === null || prev.close === 0 ? null : last.close / prev.close - 1;
  return {
    price: last.close,
    chgPct,
    turnoverRate: last.turnoverRate,
    turnover: last.turnover,
    consecUpDays: countConsecUp(bars),
  };
}

function countConsecUp(bars: readonly KlineBar[]): number {
  let n = 0;
  for (let i = bars.length - 1; i > 0; i -= 1) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    if (cur.close > prev.close) n += 1;
    else break;
  }
  return n;
}
