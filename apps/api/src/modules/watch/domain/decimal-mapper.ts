/**
 * Wire ↔ scheduler conversions for Watch quotes.
 *
 * The Flight adapter hands back a {@link SpotQuote} with Decimal-as-string
 * fields (cross-process contract). The scheduler / `evaluate` work in
 * `decimal.js` instances; this module is the single boundary translator.
 */

import { Decimal } from 'decimal.js';
import type { SpotQuote } from '@quant/shared';
import type { SpotQuoteDecimal } from './types.js';

export function decimalQuoteFromDto(q: SpotQuote): SpotQuoteDecimal {
  return {
    market: q.market,
    code: q.code,
    last: new Decimal(q.last),
    dayHigh: new Decimal(q.dayHigh),
    dayLow: new Decimal(q.dayLow),
    prevClose: new Decimal(q.prevClose),
    ts: q.ts,
  };
}
