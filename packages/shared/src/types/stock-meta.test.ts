import { describe, expect, it } from 'vitest';
import {
  QuarterlyFinancialsSchema,
  StockMetaDtoSchema,
  StockSnapshotDtoSchema,
} from './stock-meta.js';

const SAMPLE = {
  code: '600519',
  name: '贵州茅台',
  name_pinyin: 'GZMT',
  industries: '食品饮料,白酒',
  list_date: '2001-08-27',
  float_pct: '1',
  updated_at: '2026-05-01T00:00:00+00:00',
  total_share: null,
  float_share: null,
  net_assets: null,
  net_assets_period: null,
  quarterlies: [],
  financials_updated_at: null,
};

describe('StockMetaDtoSchema', () => {
  it('parses a representative payload', () => {
    expect(() => StockMetaDtoSchema.parse(SAMPLE)).not.toThrow();
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, surprise: true })).toThrow();
  });

  it('rejects a code with an exchange suffix', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, code: '600519.SH' })).toThrow();
  });

  it('rejects a code that is not 6 digits', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, code: '12345' })).toThrow();
  });

  it('rejects a malformed list_date', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, list_date: '2001/08/27' })).toThrow();
  });

  it('accepts an empty industries string', () => {
    const parsed = StockMetaDtoSchema.parse({ ...SAMPLE, industries: '' });
    expect(parsed.industries).toBe('');
  });

  it('accepts a fractional float_pct as a decimal string', () => {
    const parsed = StockMetaDtoSchema.parse({ ...SAMPLE, float_pct: '0.85' });
    expect(parsed.float_pct).toBe('0.85');
  });

  it('rejects float_pct as a JS number', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, float_pct: 1 })).toThrow();
  });

  it('rejects updated_at without a timezone offset', () => {
    expect(() =>
      StockMetaDtoSchema.parse({ ...SAMPLE, updated_at: '2026-05-01T00:00:00' }),
    ).toThrow();
  });

  it('accepts populated financial fields', () => {
    const parsed = StockMetaDtoSchema.parse({
      ...SAMPLE,
      total_share: '1256197800',
      float_share: '1256197800',
      net_assets: '243800000000',
      net_assets_period: '2025-09-30',
      quarterlies: [
        {
          period: '2025-09-30',
          revenue: '99000000000',
          operating_cost: '11000000000',
          net_profit: '52000000000',
          net_profit_excl_nr: '51800000000',
        },
      ],
      financials_updated_at: '2026-05-01T00:00:00+00:00',
    });
    expect(parsed.quarterlies).toHaveLength(1);
  });

  it('rejects more than 8 quarterlies', () => {
    const q = {
      period: '2025-09-30',
      revenue: null,
      operating_cost: null,
      net_profit: null,
      net_profit_excl_nr: null,
    };
    expect(() =>
      StockMetaDtoSchema.parse({
        ...SAMPLE,
        quarterlies: Array.from({ length: 9 }, () => q),
      }),
    ).toThrow();
  });
});

describe('QuarterlyFinancialsSchema', () => {
  it('accepts a fully populated row', () => {
    const ok = QuarterlyFinancialsSchema.parse({
      period: '2025-09-30',
      revenue: '99000000000',
      operating_cost: '11000000000',
      net_profit: '52000000000',
      net_profit_excl_nr: '51800000000',
    });
    expect(ok.period).toBe('2025-09-30');
  });

  it('accepts nulls in every numeric field', () => {
    const ok = QuarterlyFinancialsSchema.parse({
      period: '2025-09-30',
      revenue: null,
      operating_cost: null,
      net_profit: null,
      net_profit_excl_nr: null,
    });
    expect(ok.revenue).toBeNull();
  });

  it('rejects a numeric (not string) revenue', () => {
    expect(() =>
      QuarterlyFinancialsSchema.parse({
        period: '2025-09-30',
        revenue: 99000000000,
        operating_cost: null,
        net_profit: null,
        net_profit_excl_nr: null,
      }),
    ).toThrow();
  });
});

describe('StockSnapshotDtoSchema', () => {
  const baseDerived = {
    mkt_cap: null,
    float_mkt_cap: null,
    pe_ttm: null,
    pe_dynamic: null,
    pb: null,
    peg: null,
    gross_margin_ttm: null,
  };

  const baseReturns = {
    ret_1d: null,
    ret_5d: null,
    ret_10d: null,
    ret_20d: null,
    ret_90d: null,
    ret_250d: null,
  };

  it('accepts a snapshot with no live price (cold cache)', () => {
    const ok = StockSnapshotDtoSchema.parse({
      meta: SAMPLE,
      price: null,
      asof: null,
      derived: baseDerived,
      returns: baseReturns,
    });
    expect(ok.derived.mkt_cap).toBeNull();
  });

  it('accepts a fully populated snapshot', () => {
    const ok = StockSnapshotDtoSchema.parse({
      meta: SAMPLE,
      price: '1683.50',
      asof: '2026-05-04',
      derived: { ...baseDerived, mkt_cap: '2114000000000', pe_ttm: '24.5' },
      returns: { ...baseReturns, ret_1d: '0.0123' },
    });
    expect(ok.price).toBe('1683.50');
    expect(ok.derived.pe_ttm).toBe('24.5');
    expect(ok.returns.ret_1d).toBe('0.0123');
  });
});
