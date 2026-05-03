import { describe, expect, it } from 'vitest';

import {
  BlotterRowSchema,
  KlineBarSchema,
  SentimentSchema,
} from './eqty.js';

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

describe('BlotterRowSchema', () => {
  const row = {
    code: '600519',
    name: '贵州茅台',
    last: 1684.2,
    chgPct: 1.82,
    volX: 1.3,
    ma20Delta: 2.1,
    rsi14: 58,
    mcap: 2.11e12,
    sentiment: 0.78,
    evidence: '批价回升',
    evidenceTag: '雪球',
  };

  it('parses a valid row', () => {
    expect(BlotterRowSchema.parse(row).code).toBe('600519');
  });

  it('rejects missing column', () => {
    expect(() => BlotterRowSchema.parse({ code: '600519' })).toThrow();
  });
});

describe('SentimentSchema', () => {
  const s = {
    code: '600519',
    score: 0.78,
    theme: '高端白酒',
    driver: '渠道去化加速',
    target: 18.2,
    rumor: '股权激励传闻',
    cachedAt: '2026-05-03T08:00:00.000Z',
    rawLog: ['line1', 'line2'],
  };

  it('parses cachedAt with offset', () => {
    expect(SentimentSchema.parse(s).rawLog).toHaveLength(2);
  });

  it('rejects naive cachedAt', () => {
    expect(() => SentimentSchema.parse({ ...s, cachedAt: '2026-05-03 08:00:00' })).toThrow();
  });

  it('accepts empty rawLog', () => {
    expect(SentimentSchema.parse({ ...s, rawLog: [] }).rawLog).toEqual([]);
  });
});

