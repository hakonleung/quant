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

const ctx = (overrides: { quote?: SpotQuoteDecimal; prevSamplePrice?: Decimal | null } = {}) => ({
  quote: overrides.quote ?? baseQuote,
  prevSamplePrice: overrides.prevSamplePrice ?? null,
});

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
  it('gte fires when last/prev_close hits +5%', () => {
    const q = { ...baseQuote, last: new Decimal('10.50') };
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'prev_close',
        op: 'gte',
        thresholdPct: '5',
      }),
    ).toBe(true);
  });

  it('gte does not fire just below threshold', () => {
    const q = { ...baseQuote, last: new Decimal('10.49') };
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'prev_close',
        op: 'gte',
        thresholdPct: '5',
      }),
    ).toBe(false);
  });

  it('lte fires when delta is at most -2% against day_high', () => {
    const q = { ...baseQuote, last: new Decimal('10.58'), dayHigh: new Decimal('10.80') };
    // (10.58 - 10.80) / 10.80 * 100 = -2.037% ≤ -2 → true
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'day_high',
        op: 'lte',
        thresholdPct: '-2',
      }),
    ).toBe(true);
  });

  it('lte does not fire when delta is less negative than threshold', () => {
    const q = { ...baseQuote, last: new Decimal('10.65'), dayHigh: new Decimal('10.80') };
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'day_high',
        op: 'lte',
        thresholdPct: '-2',
      }),
    ).toBe(false);
  });

  it('returns false when baseline is non-positive', () => {
    const q = { ...baseQuote, prevClose: new Decimal('0') };
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'prev_close',
        op: 'gte',
        thresholdPct: '5',
      }),
    ).toBe(false);
  });
});

describe('evaluate pct (prev baseline)', () => {
  it('does not match when no prev sample is cached', () => {
    expect(
      evaluate(ctx({ prevSamplePrice: null }), {
        kind: 'pct',
        baseline: 'prev',
        op: 'lte',
        thresholdPct: '-2',
      }),
    ).toBe(false);
  });

  it('lte fires on a -2% drop tick-over-tick', () => {
    // prev=10, last=9.8 → exactly -2%
    const q = { ...baseQuote, last: new Decimal('9.8') };
    expect(
      evaluate(ctx({ quote: q, prevSamplePrice: new Decimal('10') }), {
        kind: 'pct',
        baseline: 'prev',
        op: 'lte',
        thresholdPct: '-2',
      }),
    ).toBe(true);
  });

  it('lte fires again on the next -2% step (no edge suppression at evaluator)', () => {
    // prev=9.8, last=9.6 → ~ -2.04%
    const q = { ...baseQuote, last: new Decimal('9.6') };
    expect(
      evaluate(ctx({ quote: q, prevSamplePrice: new Decimal('9.8') }), {
        kind: 'pct',
        baseline: 'prev',
        op: 'lte',
        thresholdPct: '-2',
      }),
    ).toBe(true);
  });

  it('lte does not fire when delta is less negative than threshold', () => {
    const q = { ...baseQuote, last: new Decimal('9.85') }; // -1.5% vs 10
    expect(
      evaluate(ctx({ quote: q, prevSamplePrice: new Decimal('10') }), {
        kind: 'pct',
        baseline: 'prev',
        op: 'lte',
        thresholdPct: '-2',
      }),
    ).toBe(false);
  });

  it('gte fires on a positive tick-over-tick rally', () => {
    const q = { ...baseQuote, last: new Decimal('10.21') };
    expect(
      evaluate(ctx({ quote: q, prevSamplePrice: new Decimal('10') }), {
        kind: 'pct',
        baseline: 'prev',
        op: 'gte',
        thresholdPct: '2',
      }),
    ).toBe(true);
  });
});

describe('evaluate abs', () => {
  it('gte fires at exact equality', () => {
    expect(
      evaluate(ctx(), { kind: 'abs', op: 'gte', thresholdPrice: '10.50' }),
    ).toBe(true);
  });
  it('gte does not fire below threshold', () => {
    expect(
      evaluate(ctx(), { kind: 'abs', op: 'gte', thresholdPrice: '10.51' }),
    ).toBe(false);
  });
  it('lte fires at exact equality', () => {
    expect(
      evaluate(ctx(), { kind: 'abs', op: 'lte', thresholdPrice: '10.50' }),
    ).toBe(true);
  });
  it('lte does not fire above threshold', () => {
    expect(
      evaluate(ctx(), { kind: 'abs', op: 'lte', thresholdPrice: '10.49' }),
    ).toBe(false);
  });
});
