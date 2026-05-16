import { describe, expect, it } from 'vitest';

import { KlineBarSchema, SentimentSchema } from './eqty.js';

describe('KlineBarSchema', () => {
  const bar = {
    date: '2026-05-02',
    open: 100,
    high: 110,
    low: 95,
    close: 108,
    volume: 1_000_000,
    turnover: 1.08e8,
    turnoverRate: 0.012,
    ma5: 105,
    ma10: 104,
    ma20: null,
    ma60: null,
  };

  it('parses with all four MAs (some nullable)', () => {
    expect(KlineBarSchema.parse(bar).ma20).toBeNull();
  });

  it('rejects malformed date', () => {
    expect(() => KlineBarSchema.parse({ ...bar, date: '2026/05/02' })).toThrow();
  });

  it('rejects when ma10 is missing entirely', () => {
    const { ma10: _ma10, ...missing } = bar;
    expect(() => KlineBarSchema.parse(missing)).toThrow();
  });

  it('rejects extra keys', () => {
    expect(() => KlineBarSchema.parse({ ...bar, extra: 1 })).toThrow();
  });

  it('rejects when turnover is missing', () => {
    const { turnover: _t, ...missing } = bar;
    expect(() => KlineBarSchema.parse(missing)).toThrow();
  });
});

describe('SentimentSchema', () => {
  const s = {
    code: '600519',
    cachedAt: '2026-05-03T08:00:00.000Z',
    brief: '渠道去化加速 + 估值修复空间，整体多头。',
    score: 0.78,
    coreDrivers: [
      { summary: '渠道去化加速', direction: 'positive' as const, confidence: 0.8, isRumor: false },
    ],
    hotThemes: [{ label: '高端白酒', relevance: 0.9, rationale: '消费升级' }],
    coreProducts: [{ name: '飞天茅台', revenueSharePct: 70, note: '主力单品' }],
    priceSignals: [
      {
        product: '飞天',
        change: 'price_up' as const,
        horizon: 'short_term' as const,
        magnitude: '+5%',
      },
    ],
    mAndA: [],
    supplyDemand: [],
    researchTargets: [
      {
        broker: '中信',
        rating: '买入',
        targetPrice: 2100,
        targetUpsidePct: 18.2,
        horizonMonths: 6,
        reportDate: '2026-05-01',
      },
    ],
    competitiveLandscape: null,
    coverageGaps: [],
    caveats: [],
  };

  it('parses cachedAt with offset', () => {
    expect(SentimentSchema.parse(s).hotThemes).toHaveLength(1);
  });

  it('rejects naive cachedAt', () => {
    expect(() => SentimentSchema.parse({ ...s, cachedAt: '2026-05-03 08:00:00' })).toThrow();
  });

  it('rejects score outside [0,1]', () => {
    expect(() => SentimentSchema.parse({ ...s, score: 1.5 })).toThrow();
  });

  it('accepts empty arrays', () => {
    const empty = {
      ...s,
      coreDrivers: [],
      hotThemes: [],
      coreProducts: [],
      priceSignals: [],
      researchTargets: [],
    };
    expect(SentimentSchema.parse(empty).coreDrivers).toEqual([]);
  });
});
