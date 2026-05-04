/**
 * Pure trigger evaluator for Watch (`docs/modules/W-0-watch.md` §4).
 *
 * Zero IO, zero state — given a {@link SpotQuoteDecimal} and a single
 * {@link WatchCondition}, returns `true` iff the condition fires.
 *
 * Decimal arithmetic only: callers must convert wire-format strings to
 * `Decimal` once at the boundary; this module never touches `Number`.
 */

import { Decimal } from 'decimal.js';
import type { WatchBaseline, WatchCondition } from '@quant/shared';
import type { SpotQuoteDecimal } from './types.js';

export function pickBaseline(quote: SpotQuoteDecimal, baseline: WatchBaseline): Decimal {
  switch (baseline) {
    case 'prev_close':
      return quote.prevClose;
    case 'day_high':
      return quote.dayHigh;
    case 'day_low':
      return quote.dayLow;
  }
}

export function evaluate(quote: SpotQuoteDecimal, c: WatchCondition): boolean {
  if (c.kind === 'pct') {
    const base = pickBaseline(quote, c.baseline);
    if (base.lte(0)) return false;
    const deltaPct = quote.last.minus(base).div(base).mul(100);
    const thr = new Decimal(c.thresholdPct);
    return thr.gte(0) ? deltaPct.gte(thr) : deltaPct.lte(thr);
  }
  const thr = new Decimal(c.thresholdPrice);
  return c.op === 'gte' ? quote.last.gte(thr) : quote.last.lte(thr);
}
