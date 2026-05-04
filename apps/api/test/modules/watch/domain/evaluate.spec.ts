import { Decimal } from 'decimal.js';
import { evaluate, pickBaseline } from '../../../../src/modules/watch/domain/evaluate.js';
import type { SpotQuoteDecimal } from '../../../../src/modules/watch/domain/types.js';

const baseQuote: SpotQuoteDecimal = {
  market: 'a',
  code: '600000',
  last: new Decimal('10.50'),
  dayHigh: new Decimal('10.80'),
  dayLow: new Decimal('10.00'),
  prevClose: new Decimal('10.00'),
  ts: '2026-05-04T01:30:00Z',
};

describe('pickBaseline', () => {
  it.each([
    ['prev_close', '10'],
    ['day_high', '10.8'],
    ['day_low', '10'],
  ] as const)('returns the %s baseline', (b, expected) => {
    expect(pickBaseline(baseQuote, b).toString()).toBe(expected);
  });
});

describe('evaluate pct', () => {
  it('fires when last/prev_close hits +5%', () => {
    const q = { ...baseQuote, last: new Decimal('10.50') };
    expect(
      evaluate(q, { kind: 'pct', baseline: 'prev_close', thresholdPct: '5' }),
    ).toBe(true);
  });

  it('does not fire just below threshold', () => {
    const q = { ...baseQuote, last: new Decimal('10.49') };
    expect(
      evaluate(q, { kind: 'pct', baseline: 'prev_close', thresholdPct: '5' }),
    ).toBe(false);
  });

  it('handles negative threshold against day_high', () => {
    const q = { ...baseQuote, last: new Decimal('10.58'), dayHigh: new Decimal('10.80') };
    // (10.58 - 10.80) / 10.80 * 100 = -2.037% ≤ -2 → true
    expect(
      evaluate(q, { kind: 'pct', baseline: 'day_high', thresholdPct: '-2' }),
    ).toBe(true);
  });

  it('does not fire on negative threshold when delta less negative', () => {
    const q = { ...baseQuote, last: new Decimal('10.65'), dayHigh: new Decimal('10.80') };
    expect(
      evaluate(q, { kind: 'pct', baseline: 'day_high', thresholdPct: '-2' }),
    ).toBe(false);
  });

  it('returns false when baseline is non-positive', () => {
    const q = { ...baseQuote, prevClose: new Decimal('0') };
    expect(
      evaluate(q, { kind: 'pct', baseline: 'prev_close', thresholdPct: '5' }),
    ).toBe(false);
  });
});

describe('evaluate abs', () => {
  it('gte fires at exact equality', () => {
    expect(
      evaluate(baseQuote, { kind: 'abs', op: 'gte', thresholdPrice: '10.50' }),
    ).toBe(true);
  });
  it('gte does not fire below threshold', () => {
    expect(
      evaluate(baseQuote, { kind: 'abs', op: 'gte', thresholdPrice: '10.51' }),
    ).toBe(false);
  });
  it('lte fires at exact equality', () => {
    expect(
      evaluate(baseQuote, { kind: 'abs', op: 'lte', thresholdPrice: '10.50' }),
    ).toBe(true);
  });
  it('lte does not fire above threshold', () => {
    expect(
      evaluate(baseQuote, { kind: 'abs', op: 'lte', thresholdPrice: '10.49' }),
    ).toBe(false);
  });
});
