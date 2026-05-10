/**
 * Pure-function tests for the IM stock-table formatter. Covers the
 * regression that broke `pct` rendering (decimal strings parsed as
 * numbers) and the alignment bug (Lark `lark_md` collapses spaces
 * unless the table is wrapped in a code fence).
 */

import {
  formatStockTable,
  stockTableMetaRows,
  type StockTableRow,
} from '../../../src/modules/stock-meta/domain/format-stock-table.js';

const sample: StockTableRow = {
  code: '600519',
  name: '贵州茅台',
  price: '1234.56',
  ret_1d: '0.0123',
  ret_20d: '-0.0456',
  ret_90d: '0.1500',
  ret_250d: null,
};

describe('formatStockTable', () => {
  it('wraps the output in a triple-backtick code fence', () => {
    const out = formatStockTable([sample]);
    expect(out.startsWith('```\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('renders every header column including pct', () => {
    const out = formatStockTable([sample]);
    expect(out).toContain('code');
    expect(out).toContain('name');
    expect(out).toContain('price');
    expect(out).toContain('pct%');
    expect(out).toContain('20d%');
    expect(out).toContain('90d%');
    expect(out).toContain('250d%');
  });

  it('formats decimal-string returns as signed percent (regression: pct shown as —)', () => {
    const out = formatStockTable([sample]);
    expect(out).toContain('+1.23%');
    expect(out).toContain('-4.56%');
    expect(out).toContain('+15.00%');
  });

  it('renders null returns as em-dash placeholder', () => {
    const out = formatStockTable([{ ...sample, ret_250d: null }]);
    // The 250d column for sample row is null → em-dash.
    const lines = out.split('\n');
    const dataLine = lines.find((l) => l.includes('600519'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toMatch(/—/);
  });

  it('treats empty-string returns as missing (Python sometimes serialises Decimal(0) as "")', () => {
    const out = formatStockTable([{ ...sample, ret_1d: '' }]);
    const dataLine = out.split('\n').find((l) => l.includes('600519'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('—');
  });

  it('aligns columns when names contain CJK full-width chars', () => {
    const rows: StockTableRow[] = [
      { ...sample, code: '600519', name: '贵州茅台' }, // 4 CJK = 8 cols
      { ...sample, code: '000001', name: '平安银行' }, // 4 CJK = 8 cols
      { ...sample, code: '688025', name: 'A' }, // 1 ASCII = 1 col
    ];
    const out = formatStockTable(rows);
    const lines = out.split('\n').filter((l) => l.includes('600519') || l.includes('000001'));
    // Both CJK rows should have identical char-position for the price.
    const idx0 = lines[0]!.indexOf('1234.56');
    const idx1 = lines[1]!.indexOf('1234.56');
    expect(idx0).toBe(idx1);
    expect(idx0).toBeGreaterThan(0);
  });

  it('renders an empty fence + placeholder when given no rows', () => {
    const out = formatStockTable([]);
    expect(out).toContain('```');
    expect(out).toContain('(no data)');
  });

  it('falls back to em-dash for non-numeric / scientific decimal strings', () => {
    const out = formatStockTable([
      { ...sample, code: '111111', ret_1d: 'NaN', ret_20d: 'abc', ret_90d: '0' },
    ]);
    const dataLine = out.split('\n').find((l) => l.includes('111111'));
    expect(dataLine).toBeDefined();
    // ret_1d=NaN → —, ret_20d=abc → —, ret_90d="0" → +0.00%
    expect(dataLine).toContain('+0.00%');
    expect((dataLine!.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('stockTableMetaRows', () => {
  it('golden path converts decimal-string pct values to signed percent strings', () => {
    const rows = stockTableMetaRows([sample]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['pct']).toBe('+1.23%');
    expect(row['d20']).toBe('-4.56%');
    expect(row['d90']).toBe('+15.00%');
  });

  it('passes null through for null price and null ret_* fields', () => {
    const rows = stockTableMetaRows([{ ...sample, price: null, ret_250d: null }]);
    const row = rows[0]!;
    expect(row['price']).toBeNull();
    expect(row['d250']).toBeNull();
  });

  it('returns null for every ret_*d field that is null', () => {
    const allNull: StockTableRow = {
      code: '000001',
      name: '平安银行',
      price: null,
      ret_1d: null,
      ret_20d: null,
      ret_90d: null,
      ret_250d: null,
    };
    const rows = stockTableMetaRows([allNull]);
    const row = rows[0]!;
    expect(row['pct']).toBeNull();
    expect(row['d20']).toBeNull();
    expect(row['d90']).toBeNull();
    expect(row['d250']).toBeNull();
  });

  it('returns empty array when given no rows', () => {
    expect(stockTableMetaRows([])).toEqual([]);
  });

  it('returns null for NaN-string', () => {
    const rows = stockTableMetaRows([{ ...sample, ret_1d: 'NaN' }]);
    expect(rows[0]!['pct']).toBeNull();
  });

  it('renders +0.00% for exactly zero', () => {
    const rows = stockTableMetaRows([{ ...sample, ret_1d: '0' }]);
    expect(rows[0]!['pct']).toBe('+0.00%');
  });

  it('preserves code and name fields verbatim', () => {
    const rows = stockTableMetaRows([sample]);
    const row = rows[0]!;
    expect(row['code']).toBe('600519');
    expect(row['name']).toBe('贵州茅台');
  });
});
