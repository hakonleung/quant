/**
 * Pure-function tests for the IM stock-table formatter. The columns now
 * mirror the FE EQ.LIST default-applied set (chgPct, turnoverRate,
 * turnover, consecUp, ret5d/20d/90d/250d) so this spec exercises the
 * new field names alongside the alignment / fence / placeholder
 * regressions kept from the previous shape.
 */

import {
  formatStockTable,
  stockTableMetaColumns,
  stockTableMetaRows,
  type StockTableRow,
} from '../../../src/modules/stock-meta/domain/format-stock-table.js';

const sample: StockTableRow = {
  code: '600519',
  name: '贵州茅台',
  price: '1234.56',
  chgPct: '0.0123',
  turnoverRate: '0.0210',
  turnover: '120000000',
  consecUpDays: 2,
  ret5d: '0.0234',
  ret20d: '-0.0456',
  ret90d: '0.1500',
  ret250d: null,
};

describe('formatStockTable', () => {
  it('wraps the output in a triple-backtick code fence', () => {
    const out = formatStockTable([sample]);
    expect(out.startsWith('```\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('renders every header column matching the FE list', () => {
    const out = formatStockTable([sample]);
    expect(out).toContain('code');
    expect(out).toContain('name');
    expect(out).toContain('price');
    expect(out).toContain('chg%');
    expect(out).toContain('换手');
    expect(out).toContain('成交额');
    expect(out).toContain('连涨');
    expect(out).toContain('5d%');
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
    const out = formatStockTable([{ ...sample, ret250d: null }]);
    const lines = out.split('\n');
    const dataLine = lines.find((l) => l.includes('600519'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toMatch(/—/);
  });

  it('treats empty-string returns as missing', () => {
    const out = formatStockTable([{ ...sample, chgPct: '' }]);
    const dataLine = out.split('\n').find((l) => l.includes('600519'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('—');
  });

  it('aligns columns when names contain CJK full-width chars', () => {
    const rows: StockTableRow[] = [
      { ...sample, code: '600519', name: '贵州茅台' },
      { ...sample, code: '000001', name: '平安银行' },
      { ...sample, code: '688025', name: 'A' },
    ];
    const out = formatStockTable(rows);
    const lines = out.split('\n').filter((l) => l.includes('600519') || l.includes('000001'));
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

  it('falls back to em-dash for non-numeric decimal strings', () => {
    const out = formatStockTable([
      { ...sample, code: '111111', chgPct: 'NaN', ret20d: 'abc', ret90d: '0' },
    ]);
    const dataLine = out.split('\n').find((l) => l.includes('111111'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('+0.00%');
    expect((dataLine!.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('stockTableMetaRows', () => {
  it('golden path converts decimal pct fields to signed percent strings', () => {
    const rows = stockTableMetaRows([sample]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['chgPct']).toBe('+1.23%');
    expect(row['turnoverRate']).toBe('+2.10%');
    expect(row['ret20d']).toBe('-4.56%');
    expect(row['ret90d']).toBe('+15.00%');
  });

  it('passes null through for null price and null ret fields', () => {
    const rows = stockTableMetaRows([{ ...sample, price: null, ret250d: null }]);
    const row = rows[0]!;
    expect(row['price']).toBeNull();
    expect(row['ret250d']).toBeNull();
  });

  it('returns null for every percent field when raw value is null', () => {
    const allNull: StockTableRow = {
      code: '000001',
      name: '平安银行',
      price: null,
      chgPct: null,
      turnoverRate: null,
      turnover: null,
      consecUpDays: null,
      ret5d: null,
      ret20d: null,
      ret90d: null,
      ret250d: null,
    };
    const rows = stockTableMetaRows([allNull]);
    const row = rows[0]!;
    expect(row['chgPct']).toBeNull();
    expect(row['turnoverRate']).toBeNull();
    expect(row['ret5d']).toBeNull();
    expect(row['ret20d']).toBeNull();
    expect(row['ret90d']).toBeNull();
    expect(row['ret250d']).toBeNull();
    expect(row['consecUp']).toBeNull();
  });

  it('returns empty array when given no rows', () => {
    expect(stockTableMetaRows([])).toEqual([]);
  });

  it('returns null for NaN-string', () => {
    const rows = stockTableMetaRows([{ ...sample, chgPct: 'NaN' }]);
    expect(rows[0]!['chgPct']).toBeNull();
  });

  it('renders +0.00% for exactly zero', () => {
    const rows = stockTableMetaRows([{ ...sample, chgPct: '0' }]);
    expect(rows[0]!['chgPct']).toBe('+0.00%');
  });

  it('preserves code and name fields verbatim', () => {
    const rows = stockTableMetaRows([sample]);
    const row = rows[0]!;
    expect(row['code']).toBe('600519');
    expect(row['name']).toBe('贵州茅台');
  });

  it('renders consecUp days with d suffix', () => {
    const rows = stockTableMetaRows([sample]);
    expect(rows[0]!['consecUp']).toBe('2d');
  });

  it('renders turnover values with 万/亿 suffixes', () => {
    const rows = stockTableMetaRows([sample]);
    expect(rows[0]!['turnover']).toBe('1.20亿');
  });

  it('appends evidence columns for dynamic-sector rows', () => {
    const evRow: StockTableRow = {
      ...sample,
      evidence: { vol_ratio: '1.85' },
    };
    const rows = stockTableMetaRows([evRow], ['vol_ratio']);
    expect(rows[0]!['ev_vol_ratio']).toBe('1.85');
    const cols = stockTableMetaColumns(['vol_ratio']);
    expect(cols.find((c) => c.name === 'ev_vol_ratio')?.displayName).toBe('VOL_RATIO');
  });
});
