import { Decimal } from 'decimal.js';
import { evaluate, type IntradaySample } from '../../../../src/modules/watch/domain/evaluate.js';
import type { SpotQuoteDecimal } from '../../../../src/modules/watch/domain/types.js';

const baseQuote: SpotQuoteDecimal = {
  market: 'a',
  code: '600000',
  last: new Decimal('10.50'),
  dayHigh: new Decimal('10.80'),
  dayLow: new Decimal('10.00'),
  prevClose: new Decimal('10.00'),
  amount: new Decimal('1050000'),
  volume: new Decimal('100000'),
  ts: '2026-05-04T01:30:00Z',
};

const sample = (iso: string, p: string): IntradaySample => ({
  ts: new Date(iso),
  price: new Decimal(p),
});

const ctx = (
  overrides: { quote?: SpotQuoteDecimal; intradaySamples?: readonly IntradaySample[] } = {},
) => ({
  quote: overrides.quote ?? baseQuote,
  intradaySamples: overrides.intradaySamples ?? [],
});

describe('evaluate pct (quote-baseline)', () => {
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

  it('lte fires when delta is at most -2% against day_high', () => {
    const q = { ...baseQuote, last: new Decimal('10.58'), dayHigh: new Decimal('10.80') };
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'day_high',
        op: 'lte',
        thresholdPct: '-2',
      }),
    ).toBe(true);
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

describe('evaluate pct (vwap baseline)', () => {
  it('uses amount / volume as the baseline', () => {
    const q = {
      ...baseQuote,
      last: new Decimal('10.71'),
      amount: new Decimal('1050000'),
      volume: new Decimal('100000'),
    };
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'vwap',
        op: 'gte',
        thresholdPct: '2',
      }),
    ).toBe(true);
  });

  it('does not fire when volume is zero (pre-open)', () => {
    const q = { ...baseQuote, volume: new Decimal('0') };
    expect(
      evaluate(ctx({ quote: q }), {
        kind: 'pct',
        baseline: 'vwap',
        op: 'gte',
        thresholdPct: '2',
      }),
    ).toBe(false);
  });
});

describe('evaluate pct (trend baseline — window in seconds)', () => {
  it('does not fire when no sample is old enough', () => {
    // window=120s, samples span only 30s.
    const samples = [
      sample('2026-05-04T01:30:00Z', '10.0'),
      sample('2026-05-04T01:30:30Z', '10.5'),
    ];
    expect(
      evaluate(ctx({ intradaySamples: samples }), {
        kind: 'pct',
        baseline: 'trend',
        op: 'gte',
        thresholdPct: '1',
        window: 120,
      }),
    ).toBe(false);
  });

  it('picks the most recent sample at or before latestTs - window', () => {
    // window=60s, latest at T0, samples at T0, T0-30s, T0-65s.
    // baseline = sample at T0-65s (most recent ≤ T0-60s) = 10.0
    // last = 10.30 → +3% ≥ 3%
    const samples = [
      sample('2026-05-04T01:29:00Z', '10.0'),
      sample('2026-05-04T01:29:30Z', '10.1'),
      sample('2026-05-04T01:30:00Z', '10.30'),
    ];
    const q = { ...baseQuote, last: new Decimal('10.30') };
    expect(
      evaluate(ctx({ quote: q, intradaySamples: samples }), {
        kind: 'pct',
        baseline: 'trend',
        op: 'gte',
        thresholdPct: '3',
        window: 60,
      }),
    ).toBe(true);
  });

  it('does not fire when window is undefined for trend baseline', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample(`2026-05-04T01:${String(20 + i).padStart(2, '0')}:00Z`, '10'),
    );
    expect(
      evaluate(ctx({ intradaySamples: samples }), {
        kind: 'pct',
        baseline: 'trend',
        op: 'gte',
        thresholdPct: '1',
      }),
    ).toBe(false);
  });

  it('skips the latest sample even when window is 0', () => {
    // Two samples 30s apart — latest excluded; baseline = older one.
    const samples = [
      sample('2026-05-04T01:29:30Z', '10.0'),
      sample('2026-05-04T01:30:00Z', '10.5'),
    ];
    const q = { ...baseQuote, last: new Decimal('10.5') };
    // window=0 ⇒ cutoff = latest.ts; older sample at -30s satisfies
    // <= cutoff. (10.5-10.0)/10.0 = 5% → fire.
    expect(
      evaluate(ctx({ quote: q, intradaySamples: samples }), {
        kind: 'pct',
        baseline: 'trend',
        op: 'gte',
        thresholdPct: '5',
        window: 0,
      }),
      // window=0 is rejected by zod (.min(1)) but the resolver still
      // behaves correctly if it ever escapes — covers the lower edge.
    ).toBe(true);
  });
});

describe('evaluate abs', () => {
  it('gte fires at exact equality', () => {
    expect(evaluate(ctx(), { kind: 'abs', op: 'gte', thresholdPrice: '10.50' })).toBe(true);
  });
  it('gte does not fire below threshold', () => {
    expect(evaluate(ctx(), { kind: 'abs', op: 'gte', thresholdPrice: '10.51' })).toBe(false);
  });
  it('lte fires at exact equality', () => {
    expect(evaluate(ctx(), { kind: 'abs', op: 'lte', thresholdPrice: '10.50' })).toBe(true);
  });
  it('lte does not fire above threshold', () => {
    expect(evaluate(ctx(), { kind: 'abs', op: 'lte', thresholdPrice: '10.49' })).toBe(false);
  });
});
