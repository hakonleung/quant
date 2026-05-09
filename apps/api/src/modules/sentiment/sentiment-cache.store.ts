/**
 * File-based cache for sentiment payloads.
 *
 * Replaces the Python `ParquetSentimentCache`. Two shapes:
 *
 *   - per-stock: `${dataRoot}/sentiment/stock/{code}.json` — slim
 *     `Sentiment` view (the FE-facing camelCase shape, ≤ 1 KB).
 *   - per-codes-hash: `${dataRoot}/sentiment/market/{hash}.json` —
 *     slim `MarketSentiment` view; hash = sha256(canonicalised codes).
 *
 * Cache key includes `windowDays` + `asof` (resolved to today's UTC
 * date when the request didn't pin one). 2-trading-day TTL is
 * implemented as "asof must match" — once the backing data ages out,
 * the next request gets a miss and re-runs the LLM.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MarketSentimentSchema,
  SentimentSchema,
  type MarketSentiment,
  type Sentiment,
} from '@quant/shared';
import path from 'node:path';

import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';
import { SENTIMENT_DATA_DIR } from './sentiment.token.js';

interface StockEntry {
  readonly asof: string;
  readonly windowDays: number;
  readonly value: Sentiment;
}

interface MarketEntry {
  readonly asof: string;
  readonly windowDays: number;
  readonly value: MarketSentiment;
}

@Injectable()
export class SentimentCacheStore {
  private readonly logger = new Logger(SentimentCacheStore.name);
  private readonly mutex = new Map<string, Promise<unknown>>();

  constructor(@Inject(SENTIMENT_DATA_DIR) private readonly dataRoot: string) {}

  async getStock(code: string, asof: string, windowDays: number): Promise<Sentiment | null> {
    const file = this.stockFile(code);
    const raw = await readJsonOr<unknown>(file, null);
    if (raw === null) return null;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Partial<StockEntry>;
    if (entry.asof !== asof || entry.windowDays !== windowDays) return null;
    const parsed = SentimentSchema.safeParse(entry.value);
    if (!parsed.success) {
      this.logger.warn(`sentiment_stock_cache_invalid file=${file}`);
      return null;
    }
    return parsed.data;
  }

  async putStock(value: Sentiment, asof: string, windowDays: number): Promise<void> {
    const entry: StockEntry = { asof, windowDays, value };
    await this.runLocked(`stock:${value.code}`, () =>
      atomicWriteJson(this.stockFile(value.code), entry),
    );
  }

  async getMarket(
    codeHash: string,
    asof: string,
    windowDays: number,
  ): Promise<MarketSentiment | null> {
    const file = this.marketFile(codeHash);
    const raw = await readJsonOr<unknown>(file, null);
    if (raw === null) return null;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Partial<MarketEntry>;
    if (entry.asof !== asof || entry.windowDays !== windowDays) return null;
    const parsed = MarketSentimentSchema.safeParse(entry.value);
    if (!parsed.success) {
      this.logger.warn(`sentiment_market_cache_invalid file=${file}`);
      return null;
    }
    return parsed.data;
  }

  async putMarket(value: MarketSentiment, asof: string, windowDays: number): Promise<void> {
    const entry: MarketEntry = { asof, windowDays, value };
    await this.runLocked(`market:${value.codeHash}`, () =>
      atomicWriteJson(this.marketFile(value.codeHash), entry),
    );
  }

  private stockFile(code: string): string {
    return path.join(this.dataRoot, 'sentiment', 'stock', `${code}.json`);
  }

  private marketFile(codeHash: string): string {
    return path.join(this.dataRoot, 'sentiment', 'market', `${codeHash}.json`);
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
