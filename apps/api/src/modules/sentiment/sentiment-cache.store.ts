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
 * Cache key is `(code | codeHash, windowDays)`. **TTL is 30 calendar
 * days from the original analysis timestamp** — `Sentiment.cachedAt`
 * for stock entries, `MarketSentiment.fetchedAt` for market entries.
 * News and search results age slowly enough that 30 days is a
 * reasonable upper bound; users that want fresher numbers pass
 * `fresh=1` to bypass.
 *
 * Different `windowDays` is a separate cache entry — `analyze 600519
 * windowDays=7` and the default 30-day query don't collide.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MarketSentimentSchema,
  SentimentSchema,
  type MarketSentiment,
  type Sentiment,
} from '@quant/shared';
import path from 'node:path';

import { CLOCK, type Clock } from '../../common/clock.js';
import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';
import { SENTIMENT_DATA_DIR } from './sentiment.token.js';

/** 30 calendar days. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StockEntry {
  readonly windowDays: number;
  readonly value: Sentiment;
}

interface MarketEntry {
  readonly windowDays: number;
  readonly value: MarketSentiment;
}

@Injectable()
export class SentimentCacheStore {
  private readonly logger = new Logger(SentimentCacheStore.name);
  private readonly mutex = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(SENTIMENT_DATA_DIR) private readonly dataRoot: string,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getStock(code: string, windowDays: number): Promise<Sentiment | null> {
    const file = this.stockFile(code);
    const raw = await readJsonOr<unknown>(file, null);
    if (raw === null) return null;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Partial<StockEntry>;
    if (entry.windowDays !== windowDays) return null;
    const parsed = SentimentSchema.safeParse(entry.value);
    if (!parsed.success) {
      this.logger.warn(`sentiment_stock_cache_invalid file=${file}`);
      return null;
    }
    if (this.isStale(parsed.data.cachedAt)) return null;
    return parsed.data;
  }

  async putStock(value: Sentiment, windowDays: number): Promise<void> {
    const entry: StockEntry = { windowDays, value };
    await this.runLocked(`stock:${value.code}`, () =>
      atomicWriteJson(this.stockFile(value.code), entry),
    );
  }

  async getMarket(codeHash: string, windowDays: number): Promise<MarketSentiment | null> {
    const file = this.marketFile(codeHash);
    const raw = await readJsonOr<unknown>(file, null);
    if (raw === null) return null;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Partial<MarketEntry>;
    if (entry.windowDays !== windowDays) return null;
    const parsed = MarketSentimentSchema.safeParse(entry.value);
    if (!parsed.success) {
      this.logger.warn(`sentiment_market_cache_invalid file=${file}`);
      return null;
    }
    if (this.isStale(parsed.data.fetchedAt)) return null;
    return parsed.data;
  }

  async putMarket(value: MarketSentiment, windowDays: number): Promise<void> {
    const entry: MarketEntry = { windowDays, value };
    await this.runLocked(`market:${value.codeHash}`, () =>
      atomicWriteJson(this.marketFile(value.codeHash), entry),
    );
  }

  /** True when the on-disk timestamp is older than {@link TTL_MS}. */
  private isStale(timestampIso: string): boolean {
    const t = Date.parse(timestampIso);
    if (!Number.isFinite(t)) return true;
    return this.clock.now().getTime() - t > TTL_MS;
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
