/**
 * Pure Slack payload renderer for Watch (`docs/modules/W-0-watch.md` §9.1).
 *
 * Block Kit gives us three visual tiers; the watch alert maps each
 * piece of the message onto exactly one tier so the priority hierarchy
 * is unambiguous:
 *
 *   • Header block (plain_text): `{name} [{code}]` — large bold.
 *   • Section block (mrkdwn): `{emoji} *{pct}* {emoji}   {priceWithUnit}`
 *     — pct is bold and flanked by colored squares (CN convention:
 *     red on rise, green on fall). Slack mrkdwn can't color inline
 *     text, so the squares + the attachment stripe carry direction.
 *   • Context block (mrkdwn): comma-joined matched conditions in
 *     Slack's smallest gray text.
 */

import { Decimal } from 'decimal.js';
import type { WatchCondition, WatchMarket } from '@quant/shared';
import type { SpotQuoteDecimal } from './types.js';

export interface SlackHeaderBlock {
  readonly type: 'header';
  readonly text: { readonly type: 'plain_text'; readonly text: string; readonly emoji: boolean };
}

export interface SlackSectionBlock {
  readonly type: 'section';
  readonly text: { readonly type: 'mrkdwn'; readonly text: string };
}

export interface SlackContextBlock {
  readonly type: 'context';
  readonly elements: ReadonlyArray<{ readonly type: 'mrkdwn'; readonly text: string }>;
}

export type SlackBlock = SlackHeaderBlock | SlackSectionBlock | SlackContextBlock;

export interface SlackAttachment {
  readonly color: string;
  readonly blocks: readonly SlackBlock[];
}

export interface SlackPayload {
  readonly text?: string;
  readonly attachments: readonly SlackAttachment[];
}

// CN equity convention — 涨红跌绿. Stripe color and the square emoji
// flanking the pct number carry the up/down cue; Slack mrkdwn cannot
// color inline text directly, so attachment color + emoji is the
// strongest signal we have.
const COLOR_UP = '#ef4444';
const COLOR_DOWN = '#22c55e';
const COLOR_FLAT = '#9ca3af';

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
    return `pct($, ${c.baseline}) ${renderOp(c.op)} ${v.toString()}%`;
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
  const direction = changePct.gt(0)
    ? { emoji: ':large_red_square:', color: COLOR_UP }
    : changePct.lt(0)
      ? { emoji: ':large_green_square:', color: COLOR_DOWN }
      : { emoji: ':white_square:', color: COLOR_FLAT };
  const condsStr = matched.map(renderCondition).join(', ');
  const pctLine = `${direction.emoji} *${pctStr}* ${direction.emoji}   ${priceStr}`;

  return {
    attachments: [
      {
        color: direction.color,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `${name} [${code}]`, emoji: false },
          },
          { type: 'section', text: { type: 'mrkdwn', text: pctLine } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: condsStr }] },
        ],
      },
    ],
  };
}
