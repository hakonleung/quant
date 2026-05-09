/**
 * Pure Slack payload renderer for Watch (`docs/modules/W-0-watch.md` §9.1).
 *
 * The payload is the simplest Slack incoming-webhook shape: a single
 * `text` field with mrkdwn — no attachments, no Block Kit. Three lines:
 *
 *   *{name} [{code}]*
 *   {emoji} *{pct}* {emoji}   {priceWithUnit}
 *   {comma-joined matched conditions}
 *
 * CN convention: 涨红跌绿. The flanking square emoji carry the
 * up/down cue (mrkdwn cannot color inline text).
 */

import { Decimal } from 'decimal.js';
import type { WatchCondition, WatchMarket } from '@quant/shared';
import type { SpotQuoteDecimal } from './types.js';

export interface SlackPayload {
  readonly text: string;
}

const PRICE_PREFIX: Readonly<Record<WatchMarket, string>> = {
  a: '¥',
  hk: 'HK$',
  us: '$',
};

function formatPrice(price: Decimal, market: WatchMarket): string {
  if (market === 'us') {
    const dp = price.decimalPlaces();
    const used = Math.min(4, Math.max(2, dp));
    return price.toFixed(used);
  }
  return price.toFixed(2);
}

function priceWithUnit(price: Decimal, market: WatchMarket): string {
  return `${PRICE_PREFIX[market]}${formatPrice(price, market)}`;
}

function formatSignedPct(pct: Decimal): string {
  const fixed = pct.toFixed(2);
  return pct.gte(0) ? `+${fixed}%` : `${fixed}%`;
}

function renderOp(op: 'gte' | 'lte'): string {
  return op === 'gte' ? '>=' : '<=';
}

export function renderCondition(c: WatchCondition): string {
  if (c.kind === 'pct') {
    const v = new Decimal(c.thresholdPct);
    const baselineLabel =
      c.baseline === 'trend' && c.window !== undefined ? `trend(${String(c.window)}s)` : c.baseline;
    return `pct($, ${baselineLabel}) ${renderOp(c.op)} ${v.toString()}%`;
  }
  const price = new Decimal(c.thresholdPrice);
  return `abs($) ${renderOp(c.op)} ${price.toFixed(2)}`;
}

export function buildPayload(args: {
  code: string;
  name: string;
  market: WatchMarket;
  quote: SpotQuoteDecimal;
  matched: ReadonlyArray<WatchCondition>;
}): SlackPayload {
  const { code, name, market, quote, matched } = args;
  const changePct = quote.prevClose.gt(0)
    ? quote.last.div(quote.prevClose).minus(1).mul(100)
    : new Decimal(0);
  const pctStr = formatSignedPct(changePct);
  const priceStr = priceWithUnit(quote.last, market);
  const emoji = changePct.gt(0)
    ? ':large_red_square:'
    : changePct.lt(0)
      ? ':large_green_square:'
      : ':white_square:';
  const condsStr = matched.map(renderCondition).join(', ');
  const headerLine = `*${name} [${code}]*`;
  const pctLine = `${emoji} *${pctStr}* ${emoji}   ${priceStr}`;
  const lines = [headerLine, pctLine];
  if (condsStr !== '') lines.push(condsStr);
  return { text: lines.join('\n') };
}
