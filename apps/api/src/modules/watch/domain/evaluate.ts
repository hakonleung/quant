/**
 * Pure trigger evaluator for Watch (`docs/modules/W-0-watch.md` §4).
 *
 * Zero IO, zero state — given a {@link SpotQuoteDecimal}, an optional
 * previous-sample price (same trading day), and a single
 * {@link WatchCondition}, returns `true` iff the condition fires.
 *
 * Decimal arithmetic only: callers must convert wire-format strings to
 * `Decimal` once at the boundary; this module never touches `Number`.
 */

import { Decimal } from 'decimal.js';
import type { WatchBaseline, WatchCondition } from '@quant/shared';
import type { SpotQuoteDecimal } from './types.js';

export interface EvalContext {
  readonly quote: SpotQuoteDecimal;
  /**
   * Last successful sample's `last` price within the current trading
   * day; `null` when no prior sample exists or the cached one is from
   * a different trading day. Required input for the `prev` baseline.
   */
  readonly prevSamplePrice: Decimal | null;
}

type QuoteBaseline = Exclude<WatchBaseline, 'prev'>;

export function pickBaseline(quote: SpotQuoteDecimal, baseline: QuoteBaseline): Decimal {
  switch (baseline) {
    case 'prev_close':
      return quote.prevClose;
    case 'day_high':
      return quote.dayHigh;
    case 'day_low':
      return quote.dayLow;
  }
}

function resolveBaseline(ctx: EvalContext, baseline: WatchBaseline): Decimal | null {
  if (baseline === 'prev') return ctx.prevSamplePrice;
  return pickBaseline(ctx.quote, baseline);
}

export function evaluate(ctx: EvalContext, c: WatchCondition): boolean {
  if (c.kind === 'pct') {
    const base = resolveBaseline(ctx, c.baseline);
    if (base === null || base.lte(0)) return false;
    const deltaPct = ctx.quote.last.minus(base).div(base).mul(100);
    const thr = new Decimal(c.thresholdPct);
    return c.op === 'gte' ? deltaPct.gte(thr) : deltaPct.lte(thr);
  }
  const thr = new Decimal(c.thresholdPrice);
  return c.op === 'gte' ? ctx.quote.last.gte(thr) : ctx.quote.last.lte(thr);
}
