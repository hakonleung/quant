import { describe, expect, it } from 'vitest';
import { StockMetaDtoSchema } from './stock-meta.js';

const SAMPLE = {
  code: '600519',
  name: '贵州茅台',
  name_pinyin: 'GZMT',
  industries: '食品饮料,白酒',
  list_date: '2001-08-27',
  float_pct: '1',
  updated_at: '2026-05-01T00:00:00+00:00',
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
});
