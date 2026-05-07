import { Decimal } from 'decimal.js';
import { buildPayload, renderCondition } from '../../../../src/modules/watch/domain/format.js';
import type { SpotQuoteDecimal } from '../../../../src/modules/watch/domain/types.js';

const aQuote: SpotQuoteDecimal = {
  market: 'a',
  code: '600000',
  last: new Decimal('12.34'),
  dayHigh: new Decimal('12.50'),
  dayLow: new Decimal('12.00'),
  prevClose: new Decimal('12.08'),
  amount: new Decimal('1234000'),
  volume: new Decimal('100000'),
  ts: '2026-05-04T01:30:00Z',
};

describe('buildPayload', () => {
  it('renders a single mrkdwn text with header / pct / conds lines', () => {
    const out = buildPayload({
      code: '600000',
      name: '浦发银行',
      market: 'a',
      quote: aQuote,
      matched: [{ kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '2' }],
    });
    expect(out.text).toBe(
      [
        '*浦发银行 [600000]*',
        ':large_red_square: *+2.15%* :large_red_square:   ¥12.34',
        'pct($, prev_close) >= 2%',
      ].join('\n'),
    );
  });

  it('joins multiple matched conditions with comma in the conds line', () => {
    const out = buildPayload({
      code: '600000',
      name: '浦发银行',
      market: 'a',
      quote: aQuote,
      matched: [
        { kind: 'pct', baseline: 'day_high', op: 'lte', thresholdPct: '-2' },
        { kind: 'abs', op: 'gte', thresholdPrice: '12.00' },
      ],
    });
    expect(out.text).toContain('pct($, day_high) <= -2%, abs($) >= 12.00');
  });

  it('uses CN convention: red square emoji on a rise', () => {
    const out = buildPayload({
      code: '600000',
      name: 'X',
      market: 'a',
      quote: aQuote,
      matched: [],
    });
    expect(out.text).toContain(':large_red_square:');
    // No conds line when matched is empty.
    expect(out.text.split('\n')).toHaveLength(2);
  });

  it('uses CN convention: green square emoji on a fall', () => {
    const q = { ...aQuote, last: new Decimal('11.50'), prevClose: new Decimal('12.00') };
    const out = buildPayload({
      code: '600000',
      name: 'X',
      market: 'a',
      quote: q,
      matched: [{ kind: 'abs', op: 'lte', thresholdPrice: '11.60' }],
    });
    expect(out.text).toContain(':large_green_square:');
    expect(out.text).toContain('*-4.17%*');
  });

  it('formats US prices with up to 4 dp and a $ prefix', () => {
    const usQuote: SpotQuoteDecimal = {
      market: 'us',
      code: 'AAPL',
      last: new Decimal('123.4567'),
      dayHigh: new Decimal('124'),
      dayLow: new Decimal('122'),
      prevClose: new Decimal('123'),
      amount: new Decimal('12345670'),
      volume: new Decimal('100000'),
      ts: '2026-05-04T13:30:00Z',
    };
    const out = buildPayload({
      code: 'AAPL',
      name: 'Apple',
      market: 'us',
      quote: usQuote,
      matched: [{ kind: 'abs', op: 'lte', thresholdPrice: '125' }],
    });
    expect(out.text).toContain('$123.4567');
  });

  it('uses HK$ prefix for Hong Kong tickers', () => {
    const hkQuote: SpotQuoteDecimal = {
      market: 'hk',
      code: '00700',
      last: new Decimal('400.50'),
      dayHigh: new Decimal('405'),
      dayLow: new Decimal('399'),
      prevClose: new Decimal('400'),
      amount: new Decimal('40050000'),
      volume: new Decimal('100000'),
      ts: '2026-05-04T01:30:00Z',
    };
    const out = buildPayload({
      code: '00700',
      name: '腾讯',
      market: 'hk',
      quote: hkQuote,
      matched: [{ kind: 'abs', op: 'gte', thresholdPrice: '400' }],
    });
    expect(out.text).toContain('HK$400.50');
  });

  it('renders vwap-baseline pct condition', () => {
    expect(renderCondition({ kind: 'pct', baseline: 'vwap', op: 'lte', thresholdPct: '-2' })).toBe(
      'pct($, vwap) <= -2%',
    );
  });

  it('renders trend-baseline pct condition with window (seconds)', () => {
    expect(
      renderCondition({
        kind: 'pct',
        baseline: 'trend',
        op: 'gte',
        thresholdPct: '1',
        window: 60,
      }),
    ).toBe('pct($, trend(60s)) >= 1%');
  });
});
