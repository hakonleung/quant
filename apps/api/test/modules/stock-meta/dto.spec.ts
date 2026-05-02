import { GetBatchQuerySchema } from '../../../src/modules/stock-meta/dto/get-batch.dto.js';
import { ListByIndustryQuerySchema } from '../../../src/modules/stock-meta/dto/list-by-industry.dto.js';

describe('GetBatchQuerySchema', () => {
  it('splits a comma-separated string into an array', () => {
    const r = GetBatchQuerySchema.parse({ codes: '600519,000858' });
    expect(r.codes).toEqual(['600519', '000858']);
  });

  it('trims whitespace and drops empty fragments', () => {
    const r = GetBatchQuerySchema.parse({ codes: '600519, ,000858 , ' });
    expect(r.codes).toEqual(['600519', '000858']);
  });

  it('rejects an empty input', () => {
    expect(() => GetBatchQuerySchema.parse({ codes: '' })).toThrow();
  });

  it('rejects only whitespace / commas', () => {
    expect(() => GetBatchQuerySchema.parse({ codes: ' , , ' })).toThrow();
  });

  it('rejects batches above the cap', () => {
    const big = Array.from({ length: 600 }, (_, i) => `c${String(i)}`).join(',');
    expect(() => GetBatchQuerySchema.parse({ codes: big })).toThrow();
  });

  it('rejects unknown query keys (strict)', () => {
    expect(() => GetBatchQuerySchema.parse({ codes: '600519', extra: 1 })).toThrow();
  });
});

describe('ListByIndustryQuerySchema', () => {
  it('parses a non-empty sw_l2', () => {
    expect(ListByIndustryQuerySchema.parse({ sw_l2: '白酒' })).toEqual({ sw_l2: '白酒' });
  });

  it('rejects empty sw_l2', () => {
    expect(() => ListByIndustryQuerySchema.parse({ sw_l2: '' })).toThrow();
  });

  it('rejects extra keys', () => {
    expect(() => ListByIndustryQuerySchema.parse({ sw_l2: '白酒', q: 'x' })).toThrow();
  });
});
