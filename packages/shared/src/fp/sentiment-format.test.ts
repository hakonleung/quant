import { describe, expect, it } from 'vitest';

import type { MarketSentiment, Sentiment } from '../types/eqty.js';
import { marketSentimentLines, sentimentLines } from './sentiment-format.js';

const FULL: Sentiment = {
  market: 'a',
  code: '600519',
  cachedAt: '2026-05-06T08:00:00.000Z',
  brief: '渠道改善 + 估值修复，整体偏多。',
  score: 0.78,
  coreDrivers: [
    { summary: '业绩超预期', direction: 'positive', confidence: 0.8, isRumor: false },
    { summary: '股权激励传闻', direction: 'neutral', confidence: 0.4, isRumor: true },
  ],
  hotThemes: [{ label: '高端白酒', relevance: 0.9, rationale: '消费升级' }],
  coreProducts: [{ name: '飞天茅台', revenueSharePct: 70, note: '主力单品' }],
  priceSignals: [
    {
      product: '飞天',
      change: 'price_up',
      horizon: 'short_term',
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
  competitiveLandscape: {
    marketPosition: 'leader',
    marketSharePct: 35,
    summary: '行业第一',
    competitors: [
      { name: '五粮液', relation: 'domestic_peer', threatLevel: 'medium', note: '次高端' },
    ],
    moats: ['品牌'],
    risks: ['消费降级'],
  },
  coverageGaps: ['xueqiu'],
  caveats: ['数据窗口偏短'],
};

describe('sentimentLines', () => {
  it('includes every populated dimension as a section', () => {
    const out = sentimentLines(FULL).join('\n');
    expect(out).toContain('▎ score');
    expect(out).toContain('0.78');
    expect(out).toContain('▎ brief');
    expect(out).toContain('渠道改善');
    expect(out).toContain('▎ drivers (2)');
    expect(out).toContain('+ 业绩超预期 [0.80]');
    expect(out).toContain('[rumor]');
    expect(out).toContain('▎ themes (1)');
    expect(out).toContain('高端白酒 [r=0.90]');
    expect(out).toContain('▎ products (1)');
    expect(out).toContain('飞天茅台 [70%]');
    expect(out).toContain('▎ signals (1)');
    expect(out).toContain('飞天 ↑ short_term +5%');
    expect(out).toContain('▎ research (1)');
    expect(out).toContain('中信');
    expect(out).toContain('▎ competitive [leader]');
    expect(out).toContain('moat: 品牌');
    expect(out).toContain('▎ gaps    xueqiu');
    expect(out).toContain('▎ caveats');
    expect(out).toContain('! 数据窗口偏短');
  });

  it('skips empty sections (no m&a / no supply)', () => {
    const out = sentimentLines(FULL).join('\n');
    expect(out).not.toContain('▎ m&a');
    expect(out).not.toContain('▎ supply');
  });

  it('omits competitive section when null', () => {
    const out = sentimentLines({ ...FULL, competitiveLandscape: null }).join('\n');
    expect(out).not.toContain('▎ competitive');
  });

  it('omits brief block when brief is empty', () => {
    const out = sentimentLines({ ...FULL, brief: '' }).join('\n');
    expect(out).not.toContain('▎ brief');
  });
});

const MARKET: MarketSentiment = {
  market: 'a',
  asof: '2026-05-06',
  windowDays: 30,
  fetchedAt: '2026-05-06T00:00:00.000Z',
  codeHash: 'abc',
  codes: ['600519', '300750'],
  brief: '板块温和复苏。',
  themeClusters: [
    {
      label: 'AI算力',
      memberCodes: ['600519'],
      relatedIndustries: ['半导体'],
      heatScore: 0.7,
      trend: 'rising',
      summary: 'GPU需求强',
    },
  ],
  styleSignals: [
    { name: 'growth_over_value', confidence: 0.7, rationale: '景气方向' },
  ],
  industryTrends: [
    {
      industry: '白酒',
      summary: '景气改善',
      direction: 'improving',
      drivers: ['提价'],
      risks: ['消费降级'],
      relatedThemes: ['高端'],
    },
  ],
  caveats: [],
};

describe('marketSentimentLines', () => {
  it('renders members + themes + style + industry sections', () => {
    const out = marketSentimentLines(MARKET).join('\n');
    expect(out).toContain('▎ members 2');
    expect(out).toContain('▎ brief');
    expect(out).toContain('板块温和复苏');
    expect(out).toContain('AI算力 [1m heat=0.70 rising]');
    expect(out).toContain('▎ style');
    expect(out).toContain('growth_over_value');
    expect(out).toContain('▎ industry');
    expect(out).toContain('白酒 [improving]');
    expect(out).toContain('+ 提价');
    expect(out).toContain('- 消费降级');
  });

  it('skips empty sections', () => {
    const out = marketSentimentLines({
      ...MARKET,
      brief: '',
      themeClusters: [],
      styleSignals: [],
      industryTrends: [],
    }).join('\n');
    expect(out).not.toContain('▎ brief');
    expect(out).not.toContain('▎ themes');
    expect(out).not.toContain('▎ style');
    expect(out).not.toContain('▎ industry');
  });
});
