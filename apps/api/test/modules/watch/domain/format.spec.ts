import { Decimal } from 'decimal.js';
import { buildPayload } from '../../../../src/modules/watch/domain/format.js';
import type { SpotQuoteDecimal } from '../../../../src/modules/watch/domain/types.js';

const aQuote: SpotQuoteDecimal = {
  market: 'a',
  code: '600000',
  last: new Decimal('12.34'),
  dayHigh: new Decimal('12.50'),
  dayLow: new Decimal('12.00'),
  prevClose: new Decimal('12.08'),
  ts: '2026-05-04T01:30:00Z',
};

describe('buildPayload', () => {
  it('renders A-share row with single condition', () => {
    const out = buildPayload({
      code: '600000',
      name: '浦发银行',
      market: 'a',
      quote: aQuote,
      hits: [{ kind: 'pct', baseline: 'prev_close', thresholdPct: '2' }],
    });
    expect(out).toBe('[600000] [浦发银行] [12.34] [+2.15%] #prev_close+2%');
  });

  it('renders multiple hit conditions joined with comma', () => {
    const out = buildPayload({
      code: '600000',
      name: '浦发银行',
      market: 'a',
      quote: aQuote,
      hits: [
        { kind: 'pct', baseline: 'day_high', thresholdPct: '-2' },
        { kind: 'abs', op: 'gte', thresholdPrice: '12.00' },
      ],
    });
    expect(out).toContain('day_high-2%, >=12.00');
  });

  it('formats US prices with up to 4 dp', () => {
    const usQuote: SpotQuoteDecimal = {
      market: 'us',
      code: 'AAPL',
      last: new Decimal('123.4567'),
      dayHigh: new Decimal('124'),
      dayLow: new Decimal('122'),
      prevClose: new Decimal('123'),
      ts: '2026-05-04T13:30:00Z',
    };
    const out = buildPayload({
      code: 'AAPL',
      name: 'Apple',
      market: 'us',
      quote: usQuote,
      hits: [{ kind: 'abs', op: 'lte', thresholdPrice: '125' }],
    });
    expect(out).toMatch(/\[123\.4567]/);
  });

  it('renders negative changePct with sign', () => {
    const q = { ...aQuote, last: new Decimal('11.50'), prevClose: new Decimal('12.00') };
    const out = buildPayload({
      code: '600000',
      name: 'X',
      market: 'a',
      quote: q,
      hits: [{ kind: 'abs', op: 'lte', thresholdPrice: '11.60' }],
    });
    expect(out).toContain('[-4.17%]');
  });
});
