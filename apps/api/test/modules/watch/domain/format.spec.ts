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
  ts: '2026-05-04T01:30:00Z',
};

describe('buildPayload', () => {
  it('renders three blocks: header (name [code]), section (pct + price), context (conds)', () => {
    const out = buildPayload({
      code: '600000',
      name: '浦发银行',
      market: 'a',
      quote: aQuote,
      matched: [{ kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '2' }],
    });
    const blocks = out.attachments[0]?.blocks ?? [];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: '浦发银行 [600000]', emoji: false },
    });
    expect(blocks[1]).toEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':large_red_square: *+2.15%* :large_red_square:   ¥12.34',
      },
    });
    expect(blocks[2]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'pct($, prev_close) >= 2%' }],
    });
  });

  it('puts comma-joined matched conditions in the context block', () => {
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
    const ctx = out.attachments[0]?.blocks[2];
    expect(ctx?.type).toBe('context');
    if (ctx?.type !== 'context') throw new Error('expected context block');
    expect(ctx.elements[0]?.text).toBe(
      'pct($, day_high) <= -2%, abs($) >= 12.00',
    );
  });

  it('uses CN convention: red stripe and red square emoji on a rise', () => {
    const out = buildPayload({
      code: '600000',
      name: 'X',
      market: 'a',
      quote: aQuote,
      matched: [],
    });
    expect(out.attachments[0]?.color).toBe('#ef4444');
    const pctBlock = out.attachments[0]?.blocks[1];
    if (pctBlock?.type !== 'section') throw new Error('expected section');
    expect(pctBlock.text.text).toContain(':large_red_square:');
  });

  it('uses CN convention: green stripe and green square emoji on a fall', () => {
    const q = { ...aQuote, last: new Decimal('11.50'), prevClose: new Decimal('12.00') };
    const out = buildPayload({
      code: '600000',
      name: 'X',
      market: 'a',
      quote: q,
      matched: [{ kind: 'abs', op: 'lte', thresholdPrice: '11.60' }],
    });
    expect(out.attachments[0]?.color).toBe('#22c55e');
    const pctBlock = out.attachments[0]?.blocks[1];
    if (pctBlock?.type !== 'section') throw new Error('expected section');
    expect(pctBlock.text.text).toContain(':large_green_square:');
    expect(pctBlock.text.text).toContain('*-4.17%*');
  });

  it('formats US prices with up to 4 dp and a $ prefix', () => {
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
      matched: [{ kind: 'abs', op: 'lte', thresholdPrice: '125' }],
    });
    const pctBlock = out.attachments[0]?.blocks[1];
    if (pctBlock?.type !== 'section') throw new Error('expected section');
    expect(pctBlock.text.text).toContain('$123.4567');
  });

  it('uses HK$ prefix for Hong Kong tickers', () => {
    const hkQuote: SpotQuoteDecimal = {
      market: 'hk',
      code: '00700',
      last: new Decimal('400.50'),
      dayHigh: new Decimal('405'),
      dayLow: new Decimal('399'),
      prevClose: new Decimal('400'),
      ts: '2026-05-04T01:30:00Z',
    };
    const out = buildPayload({
      code: '00700',
      name: '腾讯',
      market: 'hk',
      quote: hkQuote,
      matched: [{ kind: 'abs', op: 'gte', thresholdPrice: '400' }],
    });
    const pctBlock = out.attachments[0]?.blocks[1];
    if (pctBlock?.type !== 'section') throw new Error('expected section');
    expect(pctBlock.text.text).toContain('HK$400.50');
  });

  it('renders prev-baseline pct condition', () => {
    expect(
      renderCondition({ kind: 'pct', baseline: 'prev', op: 'lte', thresholdPct: '-2' }),
    ).toBe('pct($, prev) <= -2%');
  });

  it('omits the fallback text field — Block Kit carries the message', () => {
    const out = buildPayload({
      code: '600000',
      name: '浦发银行',
      market: 'a',
      quote: aQuote,
      matched: [{ kind: 'pct', baseline: 'prev_close', op: 'gte', thresholdPct: '2' }],
    });
    expect(out.text).toBeUndefined();
  });
});
