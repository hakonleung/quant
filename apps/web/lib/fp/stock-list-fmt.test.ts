import { describe, expect, it } from 'vitest';

import {
  fmtChgPct,
  fmtCny,
  fmtConsecUp,
  fmtPct,
  fmtPrice,
  fmtRatio,
} from './stock-list-fmt.js';

describe('fmtPrice', () => {
  it('formats with two decimals', () => {
    expect(fmtPrice(12.345)).toBe('12.35');
    expect(fmtPrice(0)).toBe('0.00');
  });
  it('renders em-dash for null / NaN / Infinity', () => {
    expect(fmtPrice(null)).toBe('—');
    expect(fmtPrice(Number.NaN)).toBe('—');
    expect(fmtPrice(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('fmtChgPct', () => {
  it('multiplies by 100 and prefixes positive sign', () => {
    expect(fmtChgPct(0.0123)).toBe('+1.23%');
    expect(fmtChgPct(-0.0123)).toBe('-1.23%');
    expect(fmtChgPct(0)).toBe('0.00%');
  });
  it('tints with ANSI when withColor=true', () => {
    expect(fmtChgPct(0.05, true)).toMatch(/\x1b\[32m/);
    expect(fmtChgPct(-0.05, true)).toMatch(/\x1b\[31m/);
    expect(fmtChgPct(0, true)).toBe('0.00%');
  });
  it('returns em-dash for null', () => {
    expect(fmtChgPct(null)).toBe('—');
    expect(fmtChgPct(null, true)).toBe('—');
  });
});

describe('fmtPct', () => {
  it('formats unsigned percent', () => {
    expect(fmtPct(0.0123)).toBe('1.23%');
    expect(fmtPct(0)).toBe('0.00%');
  });
  it('returns em-dash for null', () => {
    expect(fmtPct(null)).toBe('—');
  });
});

describe('fmtCny', () => {
  it('collapses to 亿 / 万 units', () => {
    expect(fmtCny(1.5e8)).toBe('1.50亿');
    expect(fmtCny(1.5e4)).toBe('2万'); // toFixed(0) on the 万 branch
    expect(fmtCny(123)).toBe('123');
  });
  it('returns em-dash for null', () => {
    expect(fmtCny(null)).toBe('—');
  });
});

describe('fmtConsecUp', () => {
  it('appends d suffix', () => {
    expect(fmtConsecUp(3)).toBe('3d');
    expect(fmtConsecUp(0)).toBe('0d');
  });
  it('returns em-dash for null', () => {
    expect(fmtConsecUp(null)).toBe('—');
  });
});

describe('fmtRatio', () => {
  it('rounds to two decimals', () => {
    expect(fmtRatio(12.345)).toBe('12.35');
  });
  it('returns em-dash for null / NaN', () => {
    expect(fmtRatio(null)).toBe('—');
    expect(fmtRatio(Number.NaN)).toBe('—');
  });
});
