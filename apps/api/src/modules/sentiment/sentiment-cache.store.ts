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
 *
 * Self-migration: legacy files under
 * `sentiment/stock/{code}.json` / `sentiment/market/{codeHash}.json`
 * are imported on the first matching `get` and renamed `.bak`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MarketSentimentSchema,
  SentimentSchema,
  type MarketSentiment,
  type Sentiment,
} from '@quant/shared';
import { z } from 'zod';

import { CLOCK, type Clock } from '../../common/clock.js';
import type {
  RecordStore,
  RecordTableSpec,
} from '../../common/storage/ports/record-store.port.js';
import {
  SENTIMENT_DATA_DIR,
  SENTIMENT_MARKET_RECORD_STORE,
  SENTIMENT_STOCK_RECORD_STORE,
} from './sentiment.token.js';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SentimentStockRow {
  readonly code: string;
  readonly windowDays: number;
  readonly payload_json: string;
}

export const SentimentStockRowSchema = z.object({
  code: z.string(),
  windowDays: z.number(),
  payload_json: z.string(),
});

export const SENTIMENT_STOCK_TABLE_SPEC: RecordTableSpec<SentimentStockRow> = {
  table: 'sentiment_stock',
  schema: SentimentStockRowSchema,
  pk: (row) => row.code,
  columns: [
    { name: 'code', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'windowDays', type: 'INTEGER', nullable: false },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

export interface SentimentMarketRow {
  readonly codeHash: string;
  readonly windowDays: number;
  readonly payload_json: string;
}

export const SentimentMarketRowSchema = z.object({
  codeHash: z.string(),
  windowDays: z.number(),
  payload_json: z.string(),
});

export const SENTIMENT_MARKET_TABLE_SPEC: RecordTableSpec<SentimentMarketRow> = {
  table: 'sentiment_market',
  schema: SentimentMarketRowSchema,
  pk: (row) => row.codeHash,
  columns: [
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
    @Inject(SENTIMENT_DATA_DIR) private readonly legacyRoot: string,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getStock(code: string, windowDays: number): Promise<Sentiment | null> {
    const row = await this.stockStore.get(code);
    if (row !== null) {
      if (row.windowDays !== windowDays) return null;
      return this.decodeStock(row);
    }
    return this.tryAdoptLegacyStock(code, windowDays);
  }

  async putStock(value: Sentiment, windowDays: number): Promise<void> {
    await this.runLocked(`stock:${value.code}`, async () => {
      await this.stockStore.upsert({
        code: value.code,
        windowDays,
        payload_json: JSON.stringify(value),
      });
      await this.stockStore.flush();
    });
  }

  async getMarket(codeHash: string, windowDays: number): Promise<MarketSentiment | null> {
    const row = await this.marketStore.get(codeHash);
    if (row !== null) {
      if (row.windowDays !== windowDays) return null;
      return this.decodeMarket(row);
    }
    return this.tryAdoptLegacyMarket(codeHash, windowDays);
  }

  async putMarket(value: MarketSentiment, windowDays: number): Promise<void> {
    await this.runLocked(`market:${value.codeHash}`, async () => {
      await this.marketStore.upsert({
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

  private async tryAdoptLegacyStock(
    code: string,
    windowDays: number,
  ): Promise<Sentiment | null> {
    const legacy = path.join(this.legacyRoot, 'sentiment', 'stock', `${code}.json`);
    const raw = await readJsonOrNull(legacy);
    if (raw === null) return null;
    const entry = raw as { windowDays?: unknown; value?: unknown };
    if (entry.windowDays !== windowDays) return null;
    const parsed = SentimentSchema.safeParse(entry.value);
    if (!parsed.success) {
      this.logger.warn(`legacy sentiment stock ${legacy} failed validation`);
      return null;
    }
    await this.runLocked(`stock:${code}`, async () => {
      await this.stockStore.upsert({
        code,
        windowDays,
        payload_json: JSON.stringify(parsed.data),
      });
      await this.stockStore.flush();
      await renameToBak(legacy, this.logger);
    });
    if (this.isStale(parsed.data.cachedAt)) return null;
    return parsed.data;
  }

  private async tryAdoptLegacyMarket(
    codeHash: string,
    windowDays: number,
  ): Promise<MarketSentiment | null> {
    const legacy = path.join(this.legacyRoot, 'sentiment', 'market', `${codeHash}.json`);
    const raw = await readJsonOrNull(legacy);
    if (raw === null) return null;
    const entry = raw as { windowDays?: unknown; value?: unknown };
    if (entry.windowDays !== windowDays) return null;
    const parsed = MarketSentimentSchema.safeParse(entry.value);
    if (!parsed.success) {
      this.logger.warn(`legacy sentiment market ${legacy} failed validation`);
      return null;
    }
    await this.runLocked(`market:${codeHash}`, async () => {
      await this.marketStore.upsert({
        codeHash,
        windowDays,
        payload_json: JSON.stringify(parsed.data),
      });
      await this.marketStore.flush();
      await renameToBak(legacy, this.logger);
    });
    if (this.isStale(parsed.data.fetchedAt)) return null;
    return parsed.data;
  }

  private isStale(timestampIso: string): boolean {
    const t = Date.parse(timestampIso);
    if (!Number.isFinite(t)) return true;
    return this.clock.now().getTime() - t > TTL_MS;
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

async function readJsonOrNull(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function renameToBak(file: string, logger: { warn: (m: string) => void }): Promise<void> {
  try {
    await fs.rename(file, `${file}.bak`);
  } catch (err) {
    logger.warn(`could not rename legacy ${file} to .bak: ${String(err)}`);
  }
}
