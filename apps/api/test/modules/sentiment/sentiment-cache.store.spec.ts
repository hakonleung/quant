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
  market: 'a',
  code: '000001',
  cachedAt: '2026-05-04T00:00:00.000Z',
  brief: '',
  score: 0.5,
  coreDrivers: [],
  hotThemes: [],
  coreProducts: [],
  priceSignals: [],
  mAndA: [],
  supplyDemand: [],
  researchTargets: [],
  competitiveLandscape: null,
  coverageGaps: [],
  caveats: [],
};

const MARKET: MarketSentiment = {
  market: 'a',
  asof: '2026-05-04',
  windowDays: 30,
  fetchedAt: '2026-05-04T00:00:00.000Z',
  codeHash: 'abc',
  codes: ['000001'],
  brief: '',
  themeClusters: [],
  styleSignals: [],
  industryTrends: [],
  caveats: [],
};

function makeStore(): {
  store: SentimentCacheStore;
  stock: InMemoryRecordStore<SentimentStockRow>;
  market: InMemoryRecordStore<SentimentMarketRow>;
} {
  const stock = new InMemoryRecordStore<SentimentStockRow>(SENTIMENT_STOCK_TABLE_SPEC);
  const market = new InMemoryRecordStore<SentimentMarketRow>(SENTIMENT_MARKET_TABLE_SPEC);
  const store = new SentimentCacheStore(stock, market, new FrozenClock(NOW));
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

  // Regression: legacy payloads (pre-market-aware wire) serialized
  // `market: null` inside the JSON blob. The store must fall back to the
  // row column instead of returning null and tripping the IM paid-confirm
  // gate on every cached A-share lookup.
  it('decodeStock backfills null payload.market from the row column', async () => {
    const { store, stock } = makeStore();
    const legacyPayload = { ...STOCK, market: null };
    await stock.upsert({
      market: 'a',
      code: '000001',
      windowDays: 30,
      payload_json: JSON.stringify(legacyPayload),
    });
    await expect(store.getStock('000001', 30)).resolves.toMatchObject({
      code: '000001',
      market: 'a',
    });
  });

  it('decodeMarket backfills null payload.market from the row column', async () => {
    const { store, market } = makeStore();
    const legacyPayload = { ...MARKET, market: null };
    await market.upsert({
      market: 'hk',
      codeHash: 'abc',
      windowDays: 30,
      payload_json: JSON.stringify(legacyPayload),
    });
    await expect(store.getMarket('abc', 30)).resolves.toMatchObject({
      codeHash: 'abc',
      market: 'hk',
    });
  });
});
