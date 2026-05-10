/**
 * Pure projector tests — no IO, no mocks. Each test exercises a real
 * shared DTO → terminal-shape conversion.
 */

import { describe, expect, it } from 'vitest';

import {
  klineToTerm,
  marketSentimentToTerm,
  metaToTerm,
  screenToTerm,
  sentimentToTerm,
  snapshotToTerm,
  watchToCreate,
  watchToTerm,
} from './projectors.js';

describe('metaToTerm', () => {
  const base = {
    code: '600519',
    name: '贵州茅台',
    name_pinyin: 'guizhoumaotai',
    industries: '白酒',
    list_date: '2001-08-27',
    float_pct: '1.0',
    updated_at: '2026-05-01T00:00:00Z',
    total_share: null,
    float_share: null,
    net_assets: null,
    net_assets_period: null,
    quarterlies: [],
    financials_updated_at: null,
  };

  it('projects core fields and pinyin', () => {
    const out = metaToTerm(base);
    expect(out).toEqual({
      code: '600519',
      name: '贵州茅台',
      pinyin: 'guizhoumaotai',
      industry: '白酒',
      market: 'a',
    });
  });

  it('maps empty `industries` to null', () => {
    expect(metaToTerm({ ...base, industries: '' }).industry).toBeNull();
  });
});

describe('klineToTerm', () => {
  it('drops MA / turnover columns and keeps OHLCV', () => {
    const out = klineToTerm({
      date: '2026-04-30',
      open: 1380,
      high: 1410,
      low: 1370,
      close: 1402,
      volume: 1234567,
      turnover: 1.7e9,
      turnoverRate: 0.5,
      ma5: 1400,
      ma10: 1395,
      ma20: 1380,
      ma60: 1300,
    });
    expect(out).toEqual({
      date: '2026-04-30',
      open: 1380,
      high: 1410,
      low: 1370,
      close: 1402,
      volume: 1234567,
    });
  });
});

describe('snapshotToTerm', () => {
  const meta = {
    code: '600519',
    name: '贵州茅台',
    name_pinyin: 'gzmt',
    industries: '白酒',
    list_date: '2001-08-27',
    float_pct: '1.0',
    updated_at: '2026-05-01T00:00:00Z',
    total_share: null,
    float_share: null,
    net_assets: null,
    net_assets_period: null,
    quarterlies: [],
    financials_updated_at: null,
  };
  it('decimal-as-string fields parsed to numbers', () => {
    const out = snapshotToTerm({
      meta,
      price: '1402.5',
      asof: '2026-04-30',
      derived: {
        mkt_cap: '1740000000000',
        float_mkt_cap: null,
        pe_ttm: '21.5',
        pe_dynamic: null,
        pb: null,
        peg: null,
        gross_margin_ttm: null,
      },
      returns: {
        ret_1d: null,
        ret_5d: null,
        ret_10d: null,
        ret_20d: null,
        ret_90d: null,
        ret_250d: null,
      },
    });
    expect(out.code).toBe('600519');
    expect(out.price).toBe(1402.5);
    expect(out.pe_ttm).toBe(21.5);
    expect(out.pb).toBeNull();
    expect(out.mkt_cap).toBe(1740000000000);
  });

  it('null price stays null', () => {
    const out = snapshotToTerm({
      meta,
      price: null,
      asof: null,
      derived: {
        mkt_cap: null,
        float_mkt_cap: null,
        pe_ttm: null,
        pe_dynamic: null,
        pb: null,
        peg: null,
        gross_margin_ttm: null,
      },
      returns: {
        ret_1d: null,
        ret_5d: null,
        ret_10d: null,
        ret_20d: null,
        ret_90d: null,
        ret_250d: null,
      },
    });
    expect(out.price).toBeNull();
  });
});

describe('sentimentToTerm', () => {
  it('preserves theme + driver, clamps score', () => {
    const out = sentimentToTerm({
      code: '600519',
      score: 1.5, // out-of-range — should clamp to 1
      theme: '行业景气复苏',
      driver: '需求边际改善',
      target: 1500,
      rumor: '',
      cachedAt: '2026-04-30T01:00:00.000Z',
      rawLog: [],
      result: 'analyst writeup',
    });
    expect(out).toEqual({
      code: '600519',
      score: 1,
      theme: '行业景气复苏',
      driver: '需求边际改善',
      cachedAt: '2026-04-30T01:00:00.000Z',
      result: 'analyst writeup',
    });
  });

  it('empty driver becomes null', () => {
    expect(
      sentimentToTerm({
        code: '600519',
        score: 0,
        theme: 't',
        driver: '',
        target: 0,
        rumor: '',
        cachedAt: '2026-04-30T01:00:00.000Z',
        rawLog: [],
        result: '',
      }).driver,
    ).toBeNull();
  });
});

describe('marketSentimentToTerm', () => {
  it('averages cluster heat scores; surfaces theme labels', () => {
    const out = marketSentimentToTerm(
      {
        asof: '2026-04-30',
        windowDays: 30,
        fetchedAt: '2026-04-30T01:00:00.000Z',
        codeHash: 'abc',
        codes: ['600519', '300750'],
        themeClusters: [
          { label: '高景气', memberCount: 1, heatScore: 0.6, summary: 's1' },
          { label: '困境反转', memberCount: 1, heatScore: 0.2, summary: 's2' },
        ],
        marketTrendSummary: '',
        caveats: [],
      },
      ['600519', '300750'],
    );
    expect(out.codes).toEqual(['600519', '300750']);
    expect(out.themes).toEqual(['高景气', '困境反转']);
    expect(out.score).toBeCloseTo(0.4);
  });

  it('empty clusters → score 0', () => {
    const out = marketSentimentToTerm(
      {
        asof: '2026-04-30',
        windowDays: 30,
        fetchedAt: '2026-04-30T01:00:00.000Z',
        codeHash: 'abc',
        codes: [],
        themeClusters: [],
        marketTrendSummary: '',
        caveats: [],
      },
      [],
    );
    expect(out.score).toBe(0);
  });
});

describe('screenToTerm', () => {
  it('enriches matches with names from the lookup', () => {
    const out = screenToTerm(
      {
        nl: 'autonomous-driving margins',
        asof: '2026-04-30',
        // The shared schemas have nested AST shapes we don't exercise here;
        // cast to the loose shape the projector uses.
        screenPlan: {} as never,
        universePlan: null,
        rank: null,
        matches: [
          { code: '002594', evidence: { score: 0.91 } },
          { code: '300750', evidence: {} },
        ],
        planSignature: 'sig',
      },
      (code) => (code === '002594' ? '比亚迪' : null),
    );
    expect(out.nl).toBe('autonomous-driving margins');
    expect(out.matches).toEqual([
      { code: '002594', name: '比亚迪', score: 0.91 },
      { code: '300750', name: '300750', score: null },
    ]);
    expect(out.dslSummary).toBe('2 matches');
  });
});

describe('watchToTerm / watchToCreate', () => {
  const sharedTask = {
    idx: 1,
    market: 'a' as const,
    code: '600519',
    name: '贵州茅台',
    groupName: 'demo',
    conditions: [
      {
        kind: 'pct' as const,
        baseline: 'prev_close' as const,
        op: 'gte' as const,
        thresholdPct: '3',
      },
    ],
    intervalSec: 60,
    pushIntervalSec: 300,
    remaining: null,
    notifySlack: true,
    enabled: true,
    createdAt: '2026-04-30T01:00:00.000Z',
    lastTickAt: null,
    lastPushAt: null,
    lastSampleAt: null,
    hitCount: 0,
    lastHitPrice: null,
  };

  it('projects shared task into terminal task and builds a group-bound create body', () => {
    const term = watchToTerm(sharedTask);
    expect(term.conditions[0]?.kind).toBe('pct');
    const create = watchToCreate(term, 'demo');
    expect(create.groupName).toBe('demo');
    expect(create.notifySlack).toBe(true);
    expect(create.remaining).toBeNull();
    expect(create.market).toBe('a');
    expect(create.code).toBe('600519');
  });
});
