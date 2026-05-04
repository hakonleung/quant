/**
 * Port for the realtime quote / universe upstream. Backed in production
 * by a Flight adapter; tests use an in-memory fake.
 */

import type { SpotQuote, StockBasic, WatchMarket } from '@quant/shared';

export interface WatchQuotePort {
  fetchOne(market: WatchMarket, code: string, traceId: string): Promise<SpotQuote>;
  refreshUniverse(market: 'hk' | 'us', traceId: string): Promise<readonly StockBasic[]>;
}

export const WATCH_QUOTE_PORT = Symbol('WATCH_QUOTE_PORT');
