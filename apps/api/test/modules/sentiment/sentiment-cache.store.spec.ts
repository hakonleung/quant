import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MarketSentiment, Sentiment } from '@quant/shared';

import { FrozenClock } from '../../../src/common/clock.js';
import {
  SENTIMENT_MARKET_TABLE_SPEC,
  SENTIMENT_STOCK_TABLE_SPEC,
  SentimentCacheStore,
  type SentimentMarketRow,
  type SentimentStockRow,
} from '../../../src/modules/sentiment/sentiment-cache.store.js';
import { InMemoryRecordStore } from '../../fakes/in-memory-record.store.js';

const NOW = new Date('2026-05-04T07:15:00.000Z');

const STOCK: Sentiment = {
  code: '000001',
  score: 0,
  theme: 'neutral',
  driver: '',
  target: 0,
  rumor: '',
  cachedAt: '2026-05-04T00:00:00.000Z',
  rawLog: [],
  result: '',
};

const MARKET: MarketSentiment = {
  asof: '2026-05-04',
  windowDays: 30,
  fetchedAt: '2026-05-04T00:00:00.000Z',
  codeHash: 'abc',
  codes: ['000001'],
  themeClusters: [],
  marketTrendSummary: '',
  caveats: [],
};

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sentiment-cache-'));
}

function makeStore(legacyRoot = '/unused'): {
  store: SentimentCacheStore;
  stock: InMemoryRecordStore<SentimentStockRow>;
  market: InMemoryRecordStore<SentimentMarketRow>;
} {
  const stock = new InMemoryRecordStore<SentimentStockRow>(SENTIMENT_STOCK_TABLE_SPEC);
  const market = new InMemoryRecordStore<SentimentMarketRow>(SENTIMENT_MARKET_TABLE_SPEC);
  const store = new SentimentCacheStore(stock, market, legacyRoot, new FrozenClock(NOW));
  return { store, stock, market };
}

describe('SentimentCacheStore', () => {
  it('returns null when stock cache is empty', async () => {
    const { store } = makeStore();
    await expect(store.getStock('000001', 30)).resolves.toBeNull();
  });

  it('putStock round-trips through getStock', async () => {
    const { store } = makeStore();
    await store.putStock(STOCK, 30);
    await expect(store.getStock('000001', 30)).resolves.toMatchObject({ code: '000001' });
  });

  it('different windowDays counts as a stock miss', async () => {
    const { store } = makeStore();
    await store.putStock(STOCK, 30);
    await expect(store.getStock('000001', 7)).resolves.toBeNull();
  });

  it('returns null when stock cache is stale (> 30 days)', async () => {
    const stale: Sentiment = { ...STOCK, cachedAt: '2026-03-04T00:00:00.000Z' };
    const { store } = makeStore();
    await store.putStock(stale, 30);
    await expect(store.getStock('000001', 30)).resolves.toBeNull();
  });

  it('putMarket round-trips through getMarket', async () => {
    const { store } = makeStore();
    await store.putMarket(MARKET, 30);
    await expect(store.getMarket('abc', 30)).resolves.toMatchObject({ codeHash: 'abc' });
  });

  it('different windowDays counts as a market miss', async () => {
    const { store } = makeStore();
    await store.putMarket(MARKET, 30);
    await expect(store.getMarket('abc', 7)).resolves.toBeNull();
  });

  it('migrates legacy stock json on first matching get + renames to .bak', async () => {
    const dir = await tmpDir();
    const legacy = path.join(dir, 'sentiment', 'stock', '000001.json');
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify({ windowDays: 30, value: STOCK }));

    const { store, stock } = makeStore(dir);
    const got = await store.getStock('000001', 30);
    expect(got?.code).toBe('000001');
    await expect(stock.count()).resolves.toBe(1);
    await expect(fs.access(legacy)).rejects.toBeDefined();
    await expect(fs.access(`${legacy}.bak`)).resolves.toBeUndefined();
  });

  it('legacy stock json with mismatched windowDays is a miss without import', async () => {
    const dir = await tmpDir();
    const legacy = path.join(dir, 'sentiment', 'stock', '000001.json');
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify({ windowDays: 7, value: STOCK }));

    const { store, stock } = makeStore(dir);
    await expect(store.getStock('000001', 30)).resolves.toBeNull();
    await expect(stock.count()).resolves.toBe(0);
    // Legacy file should still be present — not imported.
    await expect(fs.access(legacy)).resolves.toBeUndefined();
  });
});
