/**
 * Port for the realtime quote / universe upstream. Backed in production
 * by a Flight adapter; tests use an in-memory fake.
 */

import type { SpotQuote, StockBasic, WatchMarket } from '@quant/shared';
import type { KlineMaRef } from './evaluate.js';

export interface WatchQuotePort {
  fetchOne(market: WatchMarket, code: string, traceId: string): Promise<SpotQuote>;
  refreshUniverse(market: 'hk' | 'us', traceId: string): Promise<readonly StockBasic[]>;
}

export const WATCH_QUOTE_PORT = Symbol('WATCH_QUOTE_PORT');

/**
 * Loads the latest A-share kline MA snapshot needed by `kind: 'ma'`
 * conditions. Returns `null` when the upstream has insufficient
 * history (< 21 daily bars) or fails — callers must treat absence as
 * "do not fire" rather than as an error.
 */
export interface WatchKlineRefPort {
  loadMaRef(code: string, traceId: string): Promise<KlineMaRef | null>;
}

export const WATCH_KLINE_REF_PORT = Symbol('WATCH_KLINE_REF_PORT');
