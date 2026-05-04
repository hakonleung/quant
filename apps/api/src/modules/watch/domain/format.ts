/**
 * Pure Slack payload renderer for Watch (`docs/modules/W-0-watch.md` §9.1).
 *
 * Output shape (single-line):
 *
 *     [code] [name] [last] [+changePct%] #cond1, cond2, ...
 *
 * - last: 2 dp for A/HK, 2-4 dp for US (we standardise on 2 unless the
 *   raw quote already has more meaningful digits, capped at 4).
 * - changePct: signed, 2 dp, % suffix; computed against `prevClose`.
 * - conditions: only the ones that fired, comma-joined.
 */

import { Decimal } from 'decimal.js';
import type { WatchCondition, WatchMarket } from '@quant/shared';
import type { SpotQuoteDecimal } from './types.js';

function formatPrice(price: Decimal, market: WatchMarket): string {
  if (market === 'us') {
    const dp = price.decimalPlaces();
    const used = Math.min(4, Math.max(2, dp));
    return price.toFixed(used);
  }
  return price.toFixed(2);
}

function formatSignedPct(pct: Decimal): string {
  const fixed = pct.toFixed(2);
  return pct.gte(0) ? `+${fixed}%` : `${fixed}%`;
}

function renderCondition(c: WatchCondition): string {
  if (c.kind === 'pct') {
    const v = new Decimal(c.thresholdPct);
    const sign = v.gte(0) ? '+' : '';
    return `${c.baseline}${sign}${v.toString()}%`;
  }
  const sym = c.op === 'gte' ? '>=' : '<=';
  const price = new Decimal(c.thresholdPrice);
  return `${sym}${price.toFixed(2)}`;
}

export function buildPayload(args: {
  code: string;
  name: string;
  market: WatchMarket;
  quote: SpotQuoteDecimal;
  hits: ReadonlyArray<WatchCondition>;
}): string {
  const { code, name, market, quote, hits } = args;
  const last = formatPrice(quote.last, market);
  const changePct = quote.prevClose.gt(0)
    ? formatSignedPct(quote.last.div(quote.prevClose).minus(1).mul(100))
    : '+0.00%';
  const conds = hits.map(renderCondition).join(', ');
  return `[${code}] [${name}] [${last}] [${changePct}] #${conds}`;
}
