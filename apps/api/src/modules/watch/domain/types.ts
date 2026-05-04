/**
 * Internal domain types for Watch (`docs/modules/W-0-watch.md` §4-5).
 *
 * All Decimal-bearing scheduler structs use `decimal.js` instances; the
 * boundary (HTTP / Flight RPC) carries them as strings via the zod
 * schemas in `@quant/shared`.
 */

import { Decimal } from 'decimal.js';
import type { WatchMarket } from '@quant/shared';

export type SpotQuoteDecimal = {
  readonly market: WatchMarket;
  readonly code: string;
  readonly last: Decimal;
  readonly dayHigh: Decimal;
  readonly dayLow: Decimal;
  readonly prevClose: Decimal;
  readonly ts: string;
};
