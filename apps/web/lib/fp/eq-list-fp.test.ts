import type { KlineBar, StockMetaDto } from '@quant/shared';
import { describe, expect, it } from 'vitest';

import {
  buildRows,
  coerceNumeric,
  compareRows,
  evidenceColumnKind,
  evidenceSortKey,
  flattenEvidence,
  formatEvidence,
  formatRelativeTime,
  isPlainObject,
  sortValue,
  toNumberOrNull,
  type ListRow,
} from './eq-list-fp.js';

const meta: StockMetaDto = {
  code: '600519',
  name: '贵州茅台',
  industries: '食品饮料',
} as unknown as StockMetaDto;

const bars: KlineBar[] = [
  {
    date: '2026-04-30',
    open: 1700,
    high: 1750,
    low: 1690,
    close: 1740,
    volume: 1_000_000,
    turnover: 1_700_000_000,
    turnoverRate: 0.5,
    ma5: 1730,
    ma10: 1720,
    ma20: 1710,
    ma60: 1680,
  },
  {
    date: '2026-05-01',
    open: 1740,
    high: 1760,
    low: 1735,
    close: 1750,
    volume: 950_000,
    turnover: 1_660_000_000,
    turnoverRate: 0.45,
    ma5: 1735,
    ma10: 1725,
    ma20: 1715,
    ma60: 1685,
  },
];

describe('isPlainObject', () => {
  it('true for {} and Object.create(null)', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null) as Record<string, unknown>)).toBe(true);
  });
  it('false for null / arrays / numbers / strings / class instances', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject('s')).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
  });
});

describe('coerceNumeric', () => {
  it('converts decimal-as-string to number', () => {
    expect(coerceNumeric('123')).toBe(123);
    expect(coerceNumeric('0.5')).toBe(0.5);
    expect(coerceNumeric('-7.25')).toBe(-7.25);
  });
  it('leaves non-numeric strings alone', () => {
    expect(coerceNumeric('hello')).toBe('hello');
    expect(coerceNumeric('1e9')).toBe('1e9'); // scientific is intentionally not coerced
    expect(coerceNumeric('2026-01-01')).toBe('2026-01-01');
  });
  it('passes through non-string values verbatim', () => {
    expect(coerceNumeric(42)).toBe(42);
    expect(coerceNumeric(null)).toBeNull();
    expect(coerceNumeric([1, 2])).toEqual([1, 2]);
  });
});

describe('flattenEvidence', () => {
  it('lifts nested object values one level', () => {
    expect(
      flattenEvidence({
        metrics: { amount: '5.3', pct: '0.034' },
        window: ['2025-01-01', '2026-01-01'],
      }),
    ).toEqual({
      amount: 5.3,
      pct: 0.034,
      window: ['2025-01-01', '2026-01-01'],
    });
  });
  it('coerces numeric leaf strings into numbers', () => {
    const out = flattenEvidence({ price: '99.5', name: '茅台' });
    expect(out['price']).toBe(99.5);
    expect(out['name']).toBe('茅台');
  });
});

describe('buildRows', () => {
  it('merges meta + kline-derived stats per code', () => {
    const metaMap = new Map<string, StockMetaDto>([['600519', meta]]);
    const klineMap = new Map<string, readonly KlineBar[]>([['600519', bars]]);
    const rows = buildRows(['600519'], metaMap, klineMap, null);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.code).toBe('600519');
    expect(row['name']).toBe('贵州茅台');
    expect(row.statsReady).toBe(true);
    expect(typeof row['price']).toBe('number');
  });

  it('emits a placeholder row when kline is missing', () => {
    const rows = buildRows(['600519'], new Map(), new Map(), null);
    expect(rows[0]?.statsReady).toBe(false);
    expect(rows[0]?.price).toBe(0);
    expect(rows[0]?.chgPct).toBeNull();
  });

  it('flattens evidence into row keys', () => {
    const klineMap = new Map<string, readonly KlineBar[]>([['600519', bars]]);
    const evidence = { '600519': { metrics: { amount: '5.3' } } };
    const rows = buildRows(['600519'], new Map(), klineMap, evidence);
    expect(rows[0]?.['amount']).toBe(5.3);
  });
});

describe('evidenceColumnKind', () => {
  it.each([
    ['amount', 'cny'],
    ['AMOUNT', 'cny'],
    ['pct_chg_qfq', 'chgPct'],
    ['turnoverRate', 'chgPct'],
    ['period_return_240d', 'chgPct'],
    ['name', 'raw'],
    ['mystery', 'raw'],
  ])('%s → %s', (key, kind) => {
    expect(evidenceColumnKind(key)).toBe(kind);
  });
});

describe('toNumberOrNull', () => {
  it('passes through finite numbers', () => {
    expect(toNumberOrNull(0)).toBe(0);
    expect(toNumberOrNull(-5.5)).toBe(-5.5);
  });
  it('rejects non-finite numbers', () => {
    expect(toNumberOrNull(Number.NaN)).toBeNull();
    expect(toNumberOrNull(Infinity)).toBeNull();
  });
  it('parses decimal-as-string but not scientific or text', () => {
    expect(toNumberOrNull('99.5')).toBe(99.5);
    expect(toNumberOrNull('1e9')).toBeNull();
    expect(toNumberOrNull('hello')).toBeNull();
  });
});

describe('sortValue + compareRows', () => {
  const row = (over: Partial<ListRow>): ListRow => ({
    code: '000001',
    name: 'foo',
    statsReady: true,
    price: 10,
    chgPct: 1,
    turnoverRate: 0.1,
    turnover: 1000,
    consecUpDays: 0,
    ...over,
  });

  it('returns null for unknown keys', () => {
    expect(sortValue(row({}), 'unknown')).toBeNull();
  });

  it('returns price only when statsReady', () => {
    expect(sortValue(row({ price: 50, statsReady: true }), 'price')).toBe(50);
    expect(sortValue(row({ price: 50, statsReady: false }), 'price')).toBeNull();
  });

  it('reads ev:* keys via evidenceSortKey', () => {
    const r = row({ amount: 9000 });
    expect(sortValue(r, 'ev:amount')).toBe(9000);
  });

  it('compareRows sorts numerics ascending and pushes nulls to the front', () => {
    const a = row({ chgPct: 5 });
    const b = row({ chgPct: 2 });
    const c = row({ chgPct: null });
    const sorted = [a, b, c].sort((x, y) => compareRows(x, y, 'chgPct'));
    expect(sorted.map((r) => r.chgPct)).toEqual([null, 2, 5]);
  });

  it('compareRows falls back to localeCompare for strings', () => {
    const a = row({ name: 'beta' });
    const b = row({ name: 'alpha' });
    expect(compareRows(a, b, 'name')).toBeGreaterThan(0);
  });
});

describe('evidenceSortKey', () => {
  it.each([
    [42, 42],
    [true, 1],
    [false, 0],
    [null, null],
    [undefined, null],
    ['abc', 'abc'],
    [{}, '[object Object]'],
  ])('%j → %j', (input, expected) => {
    expect(evidenceSortKey(input)).toBe(expected);
  });
});

describe('formatEvidence', () => {
  it.each([
    [null, '—'],
    [undefined, '—'],
    [42, '42'],
    [3.14159, '3.14'],
    ['text', 'text'],
    [true, 'true'],
    [false, 'false'],
  ])('%j → %j', (input, expected) => {
    expect(formatEvidence(input)).toBe(expected);
  });
  it('JSON-stringifies arrays and objects', () => {
    expect(formatEvidence([1, 2])).toBe('[1,2]');
    expect(formatEvidence({ a: 1 })).toBe('{"a":1}');
  });
});

describe('formatRelativeTime', () => {
  /* eslint-disable no-restricted-globals -- reuse Date.UTC for deterministic test fixtures */
  const NOW = Date.UTC(2026, 4, 8, 12, 0, 0);
  /* eslint-enable no-restricted-globals */
  it('returns em-dash on undefined or non-parseable input', () => {
    expect(formatRelativeTime(undefined, NOW)).toBe('—');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
  });
  it('formats sub-minute as Ns ago', () => {
    expect(formatRelativeTime('2026-05-08T11:59:30Z', NOW)).toBe('30s ago');
  });
  it('formats sub-hour as Nm ago', () => {
    expect(formatRelativeTime('2026-05-08T11:01:30Z', NOW)).toBe('58m ago');
  });
  it('formats sub-day as Nh ago', () => {
    expect(formatRelativeTime('2026-05-08T08:00:00Z', NOW)).toBe('4h ago');
  });
  it('formats sub-month as Nd ago', () => {
    expect(formatRelativeTime('2026-05-01T12:00:00Z', NOW)).toBe('7d ago');
  });
  it('falls back to ISO date past 30 days', () => {
    expect(formatRelativeTime('2025-05-01T12:00:00Z', NOW)).toBe('2025-05-01');
  });
});
