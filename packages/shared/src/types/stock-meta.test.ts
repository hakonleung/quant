import { describe, expect, it } from 'vitest';
import { StockMetaDtoSchema } from './stock-meta.js';

const SAMPLE = {
  code: '600519.SH',
  name: '贵州茅台',
  name_pinyin: 'GZMT',
  exchange: 'SH',
  board: 'MAIN',
  industry_sw_l1: '食品饮料',
  industry_sw_l2: '白酒',
  industry_sw_l3: '高端白酒',
  list_date: '2001-08-27',
  delist_date: null,
  total_share: '1256197800',
  float_share: '1256197800',
  status: 'NORMAL',
  updated_at: '2026-05-01T00:00:00+00:00',
};

describe('StockMetaDtoSchema', () => {
  it('parses a representative payload', () => {
    expect(() => StockMetaDtoSchema.parse(SAMPLE)).not.toThrow();
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, surprise: true })).toThrow();
  });

  it('rejects an enum value outside the closed set', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, exchange: 'NYSE' })).toThrow();
  });

  it('rejects a malformed list_date', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, list_date: '2001/08/27' })).toThrow();
  });

  it('accepts null delist_date', () => {
    const parsed = StockMetaDtoSchema.parse(SAMPLE);
    expect(parsed.delist_date).toBeNull();
  });

  it('rejects floats in share counts', () => {
    expect(() => StockMetaDtoSchema.parse({ ...SAMPLE, total_share: 1256197800 })).toThrow();
  });

  it('rejects updated_at without a timezone offset', () => {
    expect(() =>
      StockMetaDtoSchema.parse({ ...SAMPLE, updated_at: '2026-05-01T00:00:00' }),
    ).toThrow();
  });
});
