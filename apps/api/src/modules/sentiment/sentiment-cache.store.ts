/**
 * Cache for sentiment payloads, backed by two `RecordStore` tables:
 *
 *   - `sentiment_stock`  (pk = `code`)        — slim `Sentiment` view
 *   - `sentiment_market` (pk = `codeHash`)    — slim `MarketSentiment` view
 *
 * Each row carries `windowDays` plus a `payload_json` blob; `(code |
 * codeHash, windowDays)` is the effective cache key. `getXxx()` with a
 * mismatched `windowDays` is a miss, same convention as before the
 * storage unification.
 *
 * TTL is 30 calendar days from the original analysis timestamp
 * (`Sentiment.cachedAt` / `MarketSentiment.fetchedAt`). Expired rows
 * are returned as `null`; the next write replaces them.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ServerConfigCenter } from '@quant/config/server';
import {
  MarketSentimentSchema,
  SentimentSchema,
  WatchMarketSchema,
  type MarketSentiment,
  type Sentiment,
  type WatchMarket,
} from '@quant/shared';
import { z } from 'zod';

import { CLOCK, type Clock } from '../../common/clock.js';
import type { RecordStore, RecordTableSpec } from '../../common/storage/ports/record-store.port.js';
import { SENTIMENT_MARKET_RECORD_STORE, SENTIMENT_STOCK_RECORD_STORE } from './sentiment.token.js';

/**
 * Composite PK: `market:code` (stock) / `market:codeHash` (market). Legacy
 * rows written before the market column existed had pk = bare code and no
 * `market` column — those are treated as `market='a'` on read. New writes
 * always include market, so the composite key namespace isolates HK / US
 * from A-share. We do NOT migrate existing parquet rows.
 */
function stockKey(market: WatchMarket, code: string): string {
  return `${market}:${code}`;
}

function marketKey(market: WatchMarket, codeHash: string): string {
  return `${market}:${codeHash}`;
}

export interface SentimentStockRow {
  readonly market: WatchMarket;
  readonly code: string;
  readonly windowDays: number;
  readonly payload_json: string;
}

export const SentimentStockRowSchema = z.object({
  market: z.preprocess((v) => (v === undefined || v === null ? 'a' : v), WatchMarketSchema),
  code: z.string(),
  windowDays: z.number(),
  payload_json: z.string(),
});

export const SENTIMENT_STOCK_TABLE_SPEC: RecordTableSpec<SentimentStockRow> = {
  table: 'sentiment_stock',
  // cast: preprocess gives input=unknown so the ZodType<V> equality check
  // rejects it, but at runtime we only ever read+validate disk rows.
  schema: SentimentStockRowSchema as unknown as z.ZodType<SentimentStockRow>,
  pk: (row) => stockKey(row.market, row.code),
  columns: [
    { name: 'market', type: 'VARCHAR', nullable: false },
    { name: 'code', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'windowDays', type: 'INTEGER', nullable: false },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

export interface SentimentMarketRow {
  readonly market: WatchMarket;
  readonly codeHash: string;
  readonly windowDays: number;
  readonly payload_json: string;
}

export const SentimentMarketRowSchema = z.object({
  market: z.preprocess((v) => (v === undefined || v === null ? 'a' : v), WatchMarketSchema),
  codeHash: z.string(),
  windowDays: z.number(),
  payload_json: z.string(),
});

export const SENTIMENT_MARKET_TABLE_SPEC: RecordTableSpec<SentimentMarketRow> = {
  table: 'sentiment_market',
  schema: SentimentMarketRowSchema as unknown as z.ZodType<SentimentMarketRow>,
  pk: (row) => marketKey(row.market, row.codeHash),
  columns: [
    { name: 'market', type: 'VARCHAR', nullable: false },
    { name: 'codeHash', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'windowDays', type: 'INTEGER', nullable: false },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

@Injectable()
export class SentimentCacheStore {
  private readonly logger = new Logger(SentimentCacheStore.name);
  private readonly mutex = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(SENTIMENT_STOCK_RECORD_STORE)
    private readonly stockStore: RecordStore<SentimentStockRow>,
    @Inject(SENTIMENT_MARKET_RECORD_STORE)
    private readonly marketStore: RecordStore<SentimentMarketRow>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getStock(
    market: WatchMarket,
    code: string,
    windowDays: number,
  ): Promise<Sentiment | null> {
    let row = await this.stockStore.get(stockKey(market, code));
    if (row === null && market === 'a') {
      row = await this.stockStore.get(code);
    }
    if (row === null) return null;
    if (row.windowDays !== windowDays) return null;
    return this.decodeStock(row);
  }

  async putStock(value: Sentiment, windowDays: number): Promise<void> {
    await this.runLocked(`stock:${value.market}:${value.code}`, async () => {
      await this.stockStore.upsert({
        market: value.market,
        code: value.code,
        windowDays,
        payload_json: JSON.stringify(value),
      });
      await this.stockStore.flush();
    });
  }

  async getMarket(
    market: WatchMarket,
    codeHash: string,
    windowDays: number,
  ): Promise<MarketSentiment | null> {
    let row = await this.marketStore.get(marketKey(market, codeHash));
    if (row === null && market === 'a') {
      row = await this.marketStore.get(codeHash);
    }
    if (row === null) return null;
    if (row.windowDays !== windowDays) return null;
    return this.decodeMarket(row);
  }

  async putMarket(value: MarketSentiment, windowDays: number): Promise<void> {
    await this.runLocked(`market:${value.market}:${value.codeHash}`, async () => {
      await this.marketStore.upsert({
        market: value.market,
        codeHash: value.codeHash,
        windowDays,
        payload_json: JSON.stringify(value),
      });
      await this.marketStore.flush();
    });
  }

  private decodeStock(row: SentimentStockRow): Sentiment | null {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.payload_json);
    } catch (err) {
      this.logger.warn(`sentiment_stock_payload_invalid code=${row.code} err=${String(err)}`);
      return null;
    }
    const result = SentimentSchema.safeParse(parsedJson);
    if (!result.success) {
      this.logger.warn(`sentiment_stock_cache_invalid code=${row.code}`);
      return null;
    }
    if (this.isStale(result.data.cachedAt)) return null;
    return result.data;
  }

  private decodeMarket(row: SentimentMarketRow): MarketSentiment | null {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.payload_json);
    } catch (err) {
      this.logger.warn(`sentiment_market_payload_invalid hash=${row.codeHash} err=${String(err)}`);
      return null;
    }
    const result = MarketSentimentSchema.safeParse(parsedJson);
    if (!result.success) {
      this.logger.warn(`sentiment_market_cache_invalid hash=${row.codeHash}`);
      return null;
    }
    if (this.isStale(result.data.fetchedAt)) return null;
    return result.data;
  }

  private isStale(timestampIso: string): boolean {
    const t = Date.parse(timestampIso);
    if (!Number.isFinite(t)) return true;
    const ttlMs = ServerConfigCenter.get().cache.sentiment.ttlMs;
    return this.clock.now().getTime() - t > ttlMs;
  }

  private async runLocked<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.mutex.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mutex.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
