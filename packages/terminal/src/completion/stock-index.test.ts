import { describe, expect, it } from 'vitest';
import { buildStockIndex } from '../completion/stock-index.js';

const data = [
  { code: '600519', name: '贵州茅台', pinyin: 'gzmt', industry: '白酒', market: 'a' as const },
  { code: '600036', name: '招商银行', pinyin: 'zsyh', industry: '银行', market: 'a' as const },
  { code: '000001', name: '平安银行', pinyin: 'payh', industry: '银行', market: 'a' as const },
];

describe('StockIndex', () => {
  const idx = buildStockIndex(data);

  it('size reflects entries (golden)', () => {
    expect(idx.size).toBe(3);
  });

  it('completes by code prefix', () => {
    const r = idx.complete('600');
    expect(r.map((m) => m.code)).toEqual(['600036', '600519']);
  });

  it('completes by name substring (CJK)', () => {
    const r = idx.complete('茅');
    expect(r.map((m) => m.code)).toEqual(['600519']);
  });

  it('completes by pinyin prefix', () => {
    const r = idx.complete('payh');
    expect(r.map((m) => m.code)).toEqual(['000001']);
  });

  it('returns [] for empty prefix (boundary)', () => {
    expect(idx.complete('')).toEqual([]);
  });

  it('respects limit', () => {
    expect(idx.complete('6', 1)).toHaveLength(1);
  });

  it('byCode lookup works', () => {
    expect(idx.byCode('000001')?.name).toBe('平安银行');
    expect(idx.byCode('999999')).toBeNull();
  });

  it('all() returns sorted entries', () => {
    expect(idx.all().map((m) => m.code)).toEqual(['000001', '600036', '600519']);
  });
});
