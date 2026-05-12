/**
 * Pure trigger evaluator for Watch (`docs/modules/06-watch.md` §4).
 *
 * Zero IO, zero state — given a {@link SpotQuoteDecimal}, an optional
 * intraday sample series for the current trading day, and a single
 * {@link WatchCondition}, returns `true` iff the condition fires.
 *
 * Decimal arithmetic only: callers must convert wire-format strings to
 * `Decimal` once at the boundary; this module never touches `Number`.
 *
 * Baselines:
 *   - `prev_close` / `day_high` / `day_low` come straight from the quote.
 *   - `vwap`  — volume-weighted-average price = `amount / volume` of the
 *               cumulative session totals on the quote. Returns null
 *               when `volume <= 0` (pre-open auction).
 *   - `trend` — the cached sample whose `ts` is the most recent at or
 *               before `<latest sample's ts> - <window seconds>`. The
 *               condition's `window` field is required and is in
 *               **seconds**. If no cached sample is old enough to
 *               satisfy the cutoff, returns null and the condition does
 *               not fire.
 */

import { Decimal } from 'decimal.js';
import type { WatchBaseline, WatchCondition, WatchMaIndicator } from '@quant/shared';
import type { SpotQuoteDecimal } from './types.js';

/** One cached intraday sample — `ts` is the quote's reported tick time. */
export interface IntradaySample {
  readonly ts: Date;
  readonly price: Decimal;
}

/**
 * Snapshot of yesterday's kline figures needed to compute a live MA
 * during the current trading session. `dropClose[N]` is the close
 * price falling out of the window when today's price replaces it —
 * i.e. the close `N` rows back from the latest kline row, inclusive of
 * latest. Live formula:
 *
 *     liveMA_N = (ma[N] * N - dropClose[N] + currentPrice) / N
 */
export interface KlineMaRef {
  readonly ma: Readonly<Record<WatchMaIndicator, Decimal>>;
  readonly dropClose: Readonly<Record<WatchMaIndicator, Decimal>>;
}

export interface EvalContext {
  readonly quote: SpotQuoteDecimal;
  /**
   * Same-day intraday samples in chronological order — **most recent
   * tick last**. Trend baseline anchors on `samples[last].ts`. Empty
   * disables the `trend` baseline (the condition will not fire).
   */
  readonly intradaySamples: readonly IntradaySample[];
  /**
   * Yesterday's MA snapshot, present only for A-share tasks with a
   * fresh kline cache. Required for `kind: 'ma'` conditions; absent
   * means MA conditions silently do not fire.
   */
  readonly klineMaRef?: KlineMaRef | null;
}

const MA_WINDOW: Readonly<Record<WatchMaIndicator, number>> = {
  ma5: 5,
  ma10: 10,
  ma20: 20,
};

function liveMa(ref: KlineMaRef, indicator: WatchMaIndicator, price: Decimal): Decimal {
  const n = MA_WINDOW[indicator];
  return ref.ma[indicator].mul(n).minus(ref.dropClose[indicator]).plus(price).div(n);
}

export function resolveBaseline(
  ctx: EvalContext,
  baseline: WatchBaseline,
  windowSec: number | undefined,
): Decimal | null {
  switch (baseline) {
    case 'prev_close':
      return ctx.quote.prevClose;
    case 'day_high':
      return ctx.quote.dayHigh;
    case 'day_low':
      return ctx.quote.dayLow;
    case 'vwap': {
      if (ctx.quote.volume.lte(0)) return null;
      return ctx.quote.amount.div(ctx.quote.volume);
    }
    case 'trend': {
      if (windowSec === undefined) return null;
      const n = ctx.intradaySamples.length;
      if (n === 0) return null;
      const latest = ctx.intradaySamples[n - 1];
      if (latest === undefined) return null;
      const cutoffMs = latest.ts.getTime() - windowSec * 1000;
      // Walk backwards, return the most recent sample at or before
      // `cutoffMs`. Skip the latest itself (i==n-1) so the baseline is
      // never the current price even when `windowSec === 0`.
      for (let i = n - 2; i >= 0; i--) {
        const s = ctx.intradaySamples[i];
        if (s === undefined) continue;
        if (s.ts.getTime() <= cutoffMs) return s.price;
      }
      return null;
    }
  }
}

export function evaluate(ctx: EvalContext, c: WatchCondition): boolean {
  if (c.kind === 'pct') {
    const base = resolveBaseline(ctx, c.baseline, c.window);
    if (base === null || base.lte(0)) return false;
    const deltaPct = ctx.quote.last.minus(base).div(base).mul(100);
    const thr = new Decimal(c.thresholdPct);
    return c.op === 'gte' ? deltaPct.gte(thr) : deltaPct.lte(thr);
  }
  if (c.kind === 'abs') {
    const thr = new Decimal(c.thresholdPrice);
    return c.op === 'gte' ? ctx.quote.last.gte(thr) : ctx.quote.last.lte(thr);
  }
  // kind === 'ma' — edge-triggered crossover. Needs a fresh kline
  // reference and at least one prior intraday sample to detect the
  // transition; non-A markets / cold start silently no-op.
  const ref = ctx.klineMaRef;
  if (ref === undefined || ref === null) return false;
  const n = ctx.intradaySamples.length;
  if (n < 2) return false;
  const curr = ctx.intradaySamples[n - 1];
  const prev = ctx.intradaySamples[n - 2];
  if (curr === undefined || prev === undefined) return false;
  const currMa = liveMa(ref, c.indicator, curr.price);
  const prevMa = liveMa(ref, c.indicator, prev.price);
  if (c.op === 'crossUp') {
    return prev.price.lt(prevMa) && curr.price.gte(currMa);
  }
  return prev.price.gt(prevMa) && curr.price.lte(currMa);
}
