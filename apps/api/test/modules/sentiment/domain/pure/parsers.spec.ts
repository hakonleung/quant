/**
 * Tests for the sentiment LLM wire-format parsers.
 *
 * Each parser must:
 *   - decode a well-formed "|"-separated line into the typed shape;
 *   - return `null` on missing pipes / unknown enum values / empty key
 *     fields (so the upstream service can drop malformed entries);
 *   - clamp numeric fields where the schema constrains them.
 */

import {
  clamp01,
  parseClusterObject,
  parseCompetitive,
  parseCompetitorLine,
  parseIndustryTrendLine,
  parseInsightLine,
  parseJsonObject,
  parsePriceSignalLine,
  parseProductLine,
  parseResearchTargetLine,
  parseStyleSignalLine,
  parseThemeTagLine,
} from '../../../../../src/modules/sentiment/domain/pure/parsers.js';

describe('parseInsightLine', () => {
  it('decodes positive insight with rumor=0', () => {
    expect(parseInsightLine('业绩超预期|+|0.8|0')).toEqual({
      summary: '业绩超预期',
      direction: 'positive',
      confidence: 0.8,
      isRumor: false,
    });
  });

  it('decodes rumor flag and clamps confidence > 1', () => {
    const r = parseInsightLine('股权激励传闻|+|2.5|1');
    expect(r?.isRumor).toBe(true);
    expect(r?.confidence).toBe(1);
  });

  it('normalises direction synonyms', () => {
    expect(parseInsightLine('foo|positive|0.4|0')?.direction).toBe('positive');
    expect(parseInsightLine('foo|-|0.4|0')?.direction).toBe('negative');
    expect(parseInsightLine('foo|neutral|0.4|0')?.direction).toBe('neutral');
  });

  it('returns null on missing fields', () => {
    expect(parseInsightLine('foo|+')).toBeNull();
  });

  it('returns null on empty summary', () => {
    expect(parseInsightLine('|+|0.5|0')).toBeNull();
  });

  it('returns null on non-string input', () => {
    expect(parseInsightLine(42)).toBeNull();
    expect(parseInsightLine(null)).toBeNull();
  });
});

describe('parseThemeTagLine', () => {
  it('decodes label / relevance / rationale', () => {
    expect(parseThemeTagLine('AI算力|0.9|GPU云需求爆发')).toEqual({
      label: 'AI算力',
      relevance: 0.9,
      rationale: 'GPU云需求爆发',
    });
  });

  it('clamps relevance', () => {
    expect(parseThemeTagLine('x|2.0|y')?.relevance).toBe(1);
    expect(parseThemeTagLine('x|-0.5|y')?.relevance).toBe(0);
  });
});

describe('parseProductLine', () => {
  it('decodes name + sharePct + note', () => {
    expect(parseProductLine('飞天茅台|70|主力单品')).toEqual({
      name: '飞天茅台',
      revenueSharePct: 70,
      note: '主力单品',
    });
  });

  it('empty sharePct → null, empty note → null', () => {
    expect(parseProductLine('foo||')).toEqual({
      name: 'foo',
      revenueSharePct: null,
      note: null,
    });
  });
});

describe('parsePriceSignalLine', () => {
  it('maps short → short_term and up → price_up', () => {
    expect(parsePriceSignalLine('GPU|up|short|+10%')).toEqual({
      product: 'GPU',
      change: 'price_up',
      horizon: 'short_term',
      magnitude: '+10%',
    });
  });

  it('returns null on unknown change enum', () => {
    expect(parsePriceSignalLine('GPU|sideways|short|x')).toBeNull();
  });

  it('returns null on unknown horizon enum', () => {
    expect(parsePriceSignalLine('GPU|up|forever|x')).toBeNull();
  });

  it('empty magnitude → null', () => {
    expect(parsePriceSignalLine('GPU|stable|spot|')?.magnitude).toBeNull();
  });
});

describe('parseResearchTargetLine', () => {
  it('decodes full target line', () => {
    expect(parseResearchTargetLine('中信|买入|180.5|22|6|2026-05-10')).toEqual({
      broker: '中信',
      rating: '买入',
      targetPrice: 180.5,
      targetUpsidePct: 22,
      horizonMonths: 6,
      reportDate: '2026-05-10',
    });
  });

  it('rejects malformed date → reportDate=null on the decoded object', () => {
    expect(parseResearchTargetLine('中信|||||')?.reportDate).toBeNull();
    expect(parseResearchTargetLine('中信|||||not-a-date')?.reportDate).toBeNull();
  });

  it('horizonMonths truncates float', () => {
    expect(parseResearchTargetLine('x|||||')?.horizonMonths).toBeNull();
    expect(parseResearchTargetLine('x||||6.7|')?.horizonMonths).toBe(6);
  });

  it('returns null on empty broker', () => {
    expect(parseResearchTargetLine('|||||')).toBeNull();
  });
});

describe('parseCompetitorLine', () => {
  it('decodes valid relation + threat', () => {
    expect(parseCompetitorLine('寒武纪|domestic_peer|high|国内主要对手')).toEqual({
      name: '寒武纪',
      relation: 'domestic_peer',
      threatLevel: 'high',
      note: '国内主要对手',
    });
  });

  it('returns null on unknown relation', () => {
    expect(parseCompetitorLine('x|unknown_rel|high|note')).toBeNull();
  });

  it('returns null on unknown threat', () => {
    expect(parseCompetitorLine('x|substitute|critical|note')).toBeNull();
  });
});

describe('parseCompetitive', () => {
  it('decodes valid landscape', () => {
    const r = parseCompetitive({
      pos: 'leader',
      share: 35,
      summary: '行业第一',
      competitors: ['x|substitute|high|note'],
      moats: ['生态'],
      risks: ['产能'],
    });
    expect(r?.marketPosition).toBe('leader');
    expect(r?.marketSharePct).toBe(35);
    expect(r?.competitors).toHaveLength(1);
    expect(r?.moats).toEqual(['生态']);
  });

  it('falls back to unclear on unknown position', () => {
    expect(parseCompetitive({ pos: 'badname' })?.marketPosition).toBe('unclear');
  });

  it('null input → null', () => {
    expect(parseCompetitive(null)).toBeNull();
    expect(parseCompetitive('not-an-obj')).toBeNull();
  });

  it('drops malformed competitor lines', () => {
    const r = parseCompetitive({
      pos: 'follower',
      competitors: ['valid|substitute|high|n', 'malformed'],
    });
    expect(r?.competitors).toHaveLength(1);
  });
});

describe('parseStyleSignalLine', () => {
  it('decodes known signal name', () => {
    expect(parseStyleSignalLine('growth_over_value|0.7|景气方向')).toEqual({
      name: 'growth_over_value',
      confidence: 0.7,
      rationale: '景气方向',
    });
  });

  it('returns null on unknown name', () => {
    expect(parseStyleSignalLine('made_up_signal|0.7|x')).toBeNull();
  });
});

describe('parseIndustryTrendLine', () => {
  it('decodes industry + semicolon-separated lists', () => {
    expect(parseIndustryTrendLine('白酒|景气改善|improving|提价;补库|产能;政策|高端;次高端')).toEqual({
      industry: '白酒',
      summary: '景气改善',
      direction: 'improving',
      drivers: ['提价', '补库'],
      risks: ['产能', '政策'],
      relatedThemes: ['高端', '次高端'],
    });
  });

  it('returns null on unknown direction', () => {
    expect(parseIndustryTrendLine('x|s|sideways||||')).toBeNull();
  });

  it('empty sub-list → empty array', () => {
    expect(parseIndustryTrendLine('x|s|stable|||')?.drivers).toEqual([]);
  });
});

describe('parseClusterObject', () => {
  it('decodes full cluster', () => {
    expect(
      parseClusterObject({
        label: 'AI算力',
        members: ['600519', '300750'],
        industries: ['半导体'],
        heat: 0.7,
        trend: 'rising',
        summary: 'GPU需求强',
      }),
    ).toEqual({
      label: 'AI算力',
      memberCodes: ['600519', '300750'],
      relatedIndustries: ['半导体'],
      heatScore: 0.7,
      trend: 'rising',
      summary: 'GPU需求强',
    });
  });

  it('filters out empty member codes (market-shape check happens upstream)', () => {
    const r = parseClusterObject({
      label: 'x',
      members: ['600519', '', '00700', 'AAPL'],
      industries: [],
      heat: 0,
      trend: 'stable',
      summary: '',
    });
    expect(r?.memberCodes).toEqual(['600519', '00700', 'AAPL']);
  });

  it('falls back to stable on unknown trend', () => {
    const r = parseClusterObject({ label: 'x', trend: 'unknown' });
    expect(r?.trend).toBe('stable');
  });
});

describe('parseJsonObject', () => {
  it('parses well-formed object', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null on invalid JSON', () => {
    expect(parseJsonObject('not json')).toBeNull();
  });

  it('returns null on JSON array', () => {
    expect(parseJsonObject('[1,2,3]')).toBeNull();
  });

  it('returns null on JSON null', () => {
    expect(parseJsonObject('null')).toBeNull();
  });
});

describe('clamp01', () => {
  it('clamps to [0,1]', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(NaN)).toBe(0);
  });
});
