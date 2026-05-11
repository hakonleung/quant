/**
 * Feishu interactive-card payload builders.
 *
 * The default broadcast path renders Slack-style mrkdwn (`*bold*`,
 * `:emoji:`) — Feishu shows that literally. For known kinds we render a
 * native interactive card pulled from the structured `meta` carried on
 * the outbound message; for everything else we strip the Slack markup
 * and fall back to plain text.
 *
 * Cards use Feishu's "lark_md" element, which supports `**bold**`,
 * `<font color='red'>...</font>`, and emoji shortcodes natively.
 */

import { maybeMetaTablesCard, maybeStockTableCard } from './feishu-card-v2.js';

/**
 * Two card envelopes ride on the same outbound channel:
 *
 *   - {@link FeishuV1Card}: legacy `{ config, header, elements }` shape.
 *     Used by every text / button / lark_md card we still hand-build.
 *   - {@link FeishuV2Card}: schema 2.0 `{ schema:"2.0", header, body }`
 *     shape. The only envelope that accepts the new card-kit content
 *     components — most importantly the native `table` element which
 *     we use for stock-list rendering (alignment is impossible inside
 *     `lark_md`; see `bodyMarkdownElement` for the prior workaround).
 *
 * The Feishu adapter's `send()` does `JSON.stringify(card)` either way,
 * so the union is fine on the wire — Feishu detects the format by the
 * presence of the `schema` field.
 */
export type FeishuCard = FeishuV1Card | FeishuV2Card;

export interface FeishuV1Card {
  readonly config: { readonly wide_screen_mode: boolean };
  readonly header: {
    readonly template: 'red' | 'green' | 'grey' | 'blue' | 'orange' | 'purple';
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
  };
  readonly elements: readonly unknown[];
}

export interface FeishuV2Card {
  readonly schema: '2.0';
  /**
   * Required when sending an inline schema-2.0 card via
   * `im.message.create` with `msg_type: 'interactive'`. Without this
   * block Feishu rejects the request with HTTP 400 ("invalid card
   * payload") — the success cases for legacy v1 cards happen to omit
   * `config` because v1 has its own `config` shape, but v2 strictly
   * requires `update_multi` (so the card can be patched in place by
   * later async-completion replies).
   */
  readonly config?: { readonly update_multi?: boolean; readonly streaming_mode?: boolean };
  readonly header: {
    readonly template: 'red' | 'green' | 'grey' | 'blue' | 'orange' | 'purple';
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
  };
  readonly body: {
    /** Optional in spec, defaults to 'vertical' but some receivers 400 without it. */
    readonly direction?: 'vertical' | 'horizontal';
    readonly elements: readonly unknown[];
  };
}

const PRICE_PREFIX: Readonly<Record<string, string>> = { a: '¥', hk: 'HK$', us: '$' };

const PCT_RE = /[+-]?\d+(?:\.\d+)?%/u;
const NEG_LEAD_RE = /^-\d/u;

/** Feishu rejects card text elements above ~5k chars; truncate generously below the limit. */
const MAX_BODY_CHARS = 3000;
const TRUNCATE_SUFFIX = '\n…(truncated)';

export function truncateForCard(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
}

export function metaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function metaNumber(meta: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Cheap, lossy strip of Slack mrkdwn for the plain-text fallback. */
export function stripSlackMrkdwn(s: string): string {
  return s
    .replace(/:large_red_square:/g, '🟥')
    .replace(/:large_green_square:/g, '🟩')
    .replace(/:white_square:/g, '⬜')
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1');
}

type Direction = 'up' | 'down' | 'flat';

function inferDirection(pctLine: string): Direction {
  if (pctLine.includes('large_red_square') || pctLine.startsWith('+')) return 'up';
  if (pctLine.includes('large_green_square') || NEG_LEAD_RE.test(pctLine.trim())) return 'down';
  return 'flat';
}

const DIR_TO_TEMPLATE: Readonly<Record<Direction, FeishuCard['header']['template']>> = {
  up: 'red',
  down: 'green',
  flat: 'grey',
};

const DIR_TO_COLOR: Readonly<Record<Direction, 'red' | 'green' | 'grey'>> = {
  up: 'red',
  down: 'green',
  flat: 'grey',
};

/**
 * Build the watch.hit card from `meta`. The text body still carries the
 * full Slack-formatted payload, so we re-derive the user-visible bits
 * from text when meta lacks something.
 */
function pctText(pctLine: string): string {
  // Card has its own colored header + dedicated price slot, so strip the
  // square-emoji cue and the trailing price out of the percent line —
  // they'd otherwise duplicate what the header colour conveys.
  const cleanPct = stripSlackMrkdwn(pctLine);
  const m = PCT_RE.exec(cleanPct);
  return m !== null ? m[0] : cleanPct.trim();
}

function watchHitElements(summaryMd: string, condsLine: string): unknown[] {
  const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: summaryMd } }];
  if (condsLine.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: stripSlackMrkdwn(condsLine) }],
    });
  }
  return elements;
}

interface HitMeta {
  readonly market: string;
  readonly code: string;
  readonly name: string;
  readonly last: string | null;
  readonly text: string;
}

function readHits(text: string, meta: Readonly<Record<string, unknown>>): HitMeta[] {
  const raw = meta['hits'];
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.flatMap((entry): HitMeta[] => {
      if (entry === null || typeof entry !== 'object') return [];
      const r = entry as Record<string, unknown>;
      const market = typeof r['market'] === 'string' ? r['market'] : 'a';
      const code = typeof r['code'] === 'string' ? r['code'] : '';
      const name = typeof r['name'] === 'string' ? r['name'] : code;
      const last = typeof r['last'] === 'string' ? r['last'] : null;
      const t = typeof r['text'] === 'string' ? r['text'] : '';
      return [{ market, code, name, last, text: t }];
    });
  }
  return [
    {
      market: metaString(meta, 'market') ?? 'a',
      code: metaString(meta, 'code') ?? '',
      name: metaString(meta, 'name') ?? (metaString(meta, 'code') ?? ''),
      last: metaString(meta, 'last'),
      text,
    },
  ];
}

function hitSummaryMd(hit: HitMeta): { summaryMd: string; condsLine: string; direction: Direction } {
  const lines = hit.text.split('\n');
  const pctLine = lines[1] ?? '';
  const condsLine = lines[2] ?? '';
  const direction = inferDirection(pctLine);
  const prefix = PRICE_PREFIX[hit.market] ?? '';
  const priceLine = hit.last !== null ? `${prefix}${hit.last}` : '';
  const summaryMd =
    `<font color='${DIR_TO_COLOR[direction]}'>${pctText(pctLine)}</font>` +
    (priceLine.length > 0 ? `   ${priceLine}` : '');
  return { summaryMd, condsLine, direction };
}

export function buildWatchHitCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuV1Card {
  const hits = readHits(text, meta);

  if (hits.length === 1) {
    const hit = hits[0]!;
    const { summaryMd, condsLine, direction } = hitSummaryMd(hit);
    return {
      config: { wide_screen_mode: true },
      header: {
        template: DIR_TO_TEMPLATE[direction],
        title: {
          tag: 'plain_text',
          content: `WATCH · [${hit.market}]${hit.name} ${hit.code}`.trim(),
        },
      },
      elements: watchHitElements(summaryMd, condsLine),
    };
  }

  const elements: unknown[] = [];
  hits.forEach((hit, idx) => {
    if (idx > 0) elements.push({ tag: 'hr' });
    const { summaryMd, condsLine } = hitSummaryMd(hit);
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**[${hit.market}]${hit.name} ${hit.code}**\n${summaryMd}`,
      },
    });
    if (condsLine.length > 0) {
      elements.push({
        tag: 'note',
        elements: [{ tag: 'lark_md', content: stripSlackMrkdwn(condsLine) }],
      });
    }
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `WATCH · ${String(hits.length)} hits` },
    },
    elements,
  };
}

/** Generic builder for arbitrary push kinds — title in the header, body
 *  as a single lark_md block. Picks a neutral tone when the kind is
 *  unknown. */
export function buildFeishuCard(message: {
  readonly title?: string;
  readonly text: string;
  readonly kind?: string;
}): FeishuV1Card {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: message.title ?? message.kind ?? 'NOTICE' },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: stripSlackMrkdwn(message.text) } }],
  };
}

/**
 * Sync `/<id>` reply card. Header colour mirrors `meta.ok`; body
 * carries the formatted result text (mrkdwn-stripped + length-clamped).
 */
export function buildInstructionReplyCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuV1Card {
  const ok = meta['ok'] === true;
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  const code = metaString(meta, 'code');
  const headerTitle = ok
    ? `✓ /${idLabel}`
    : code !== null
      ? `✗ /${idLabel} (${code})`
      : `✗ /${idLabel}`;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: ok ? 'green' : 'red',
      title: { tag: 'plain_text', content: headerTitle },
    },
    elements: [bodyMarkdownElement(text)],
  };
}

/** "Started" card emitted right after an async instruction is queued. */
export function buildInstructionAsyncStartedCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuV1Card {
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `▶ /${idLabel} queued` },
    },
    elements: [bodyMarkdownElement(text)],
  };
}

/**
 * "Completed" card pushed when the async worker finishes. Header turns
 * green/red on the result's ok bit; footer note carries the duration so
 * the user has a feel for how long the LLM call actually took.
 */
export function buildInstructionAsyncCompletedCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuV1Card {
  const ok = meta['ok'] === true;
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  const code = metaString(meta, 'code');
  const durationMs = metaNumber(meta, 'durationMs');
  const headerTitle = ok
    ? `✓ /${idLabel} done`
    : code !== null
      ? `✗ /${idLabel} (${code})`
      : `✗ /${idLabel} failed`;
  const elements: unknown[] = [bodyMarkdownElement(text)];
  if (durationMs !== null) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: `took ${(durationMs / 1000).toFixed(2)}s` }],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: ok ? 'green' : 'red',
      title: { tag: 'plain_text', content: headerTitle },
    },
    elements,
  };
}

/**
 * Render a handler's text body as Feishu's cardkit-v2 `markdown` element
 * (top-level `{ tag: 'markdown', content }`, NOT a `div` + `lark_md`).
 *
 * This is the only Feishu card text variant that:
 *   - preserves whitespace inside triple-backtick code fences (renders
 *     them as actual monospace preformatted blocks),
 *   - supports markdown tables, headings, blockquotes,
 *   - doesn't collapse runs of spaces in regular paragraphs.
 *
 * The legacy `lark_md` element renders code fences as **literal** `` ``` ``
 * characters and uses a proportional font, so any ASCII column-padding we
 * emit (stock tables, /usr spend table, /help) ends up jumbled — exactly
 * the `飞书渲染的 table 布局全是乱的` bug the screenshot showed.
 *
 * Watch.hit and the agent confirm cards stay on `lark_md` because they
 * use `<font color>` tags + emoji shortcodes that `markdown` doesn't
 * support.
 */
function bodyMarkdownElement(text: string): { tag: 'markdown'; content: string } {
  return { tag: 'markdown', content: truncateForCard(stripSlackMrkdwn(text)) };
}

// Agent confirm / decided cards live in `feishu-card-agent.ts` (kept
// out of this file to stay under the 400-LoC cap). Re-exported here so
// the Feishu adapter (and `pickCard` below) keeps importing from the
// same module surface.
export {
  buildAgentPaidConfirmCard,
  buildAgentToolProposalCard,
  buildDecidedConfirmCard,
  buildInstructionPaidConfirmCard,
} from './feishu-card-agent.js';
import {
  buildAgentPaidConfirmCard,
  buildAgentToolProposalCard,
  buildInstructionPaidConfirmCard,
} from './feishu-card-agent.js';

// Schema-2.0 native-table renderer lives in `feishu-card-v2.ts` (kept
// out of this file to stay under the 400-LoC cap and keep v1 / v2 card
// envelopes in separate modules). Imported below for `pickCard` to
// route stock-table outbounds through the native `table` widget.

/**
 * Choose a card for the message kind, or return null to fall back to
 * the stripped-mrkdwn plain-text path.
 */
/**
 * Build the colored title used by `instruction.reply` and
 * `instruction.async.completed` cards. Centralised so success ✓
 * vs failure ✗ formatting stays in lockstep across both kinds.
 */
function instructionCardTitle(
  meta: Readonly<Record<string, unknown>>,
  doneSuffix: string,
  failPrefix: string,
): { readonly ok: boolean; readonly title: string } {
  const ok = meta['ok'] === true;
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  const code = metaString(meta, 'code');
  const title = ok
    ? `✓ /${idLabel}${doneSuffix}`
    : code !== null
      ? `✗ /${idLabel} (${code})`
      : `✗ /${idLabel}${failPrefix}`;
  return { ok, title };
}

/**
 * Try the schema-2.0 native-table renderers in priority order:
 * the multi-table `tableSections` flow first, then the single-stock-
 * table fallback. Returns null when neither meta shape applies.
 */
function pickInstructionTableCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
  defaults: {
    readonly headerTitle: string;
    readonly headerTemplate: FeishuV2Card['header']['template'];
  },
): FeishuV2Card | null {
  return maybeMetaTablesCard(meta, defaults) ?? maybeStockTableCard(text, meta, defaults);
}

function instructionReplyCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuCard {
  const { ok, title } = instructionCardTitle(meta, '', '');
  const defaults = { headerTitle: title, headerTemplate: ok ? 'green' : 'red' } as const;
  return pickInstructionTableCard(text, meta, defaults) ?? buildInstructionReplyCard(text, meta);
}

function instructionAsyncCompletedCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuCard {
  const { ok, title } = instructionCardTitle(meta, ' done', ' failed');
  const defaults = { headerTitle: title, headerTemplate: ok ? 'green' : 'red' } as const;
  return pickInstructionTableCard(text, meta, defaults)
    ?? buildInstructionAsyncCompletedCard(text, meta);
}

export function pickCard(message: {
  readonly kind?: string;
  readonly title?: string;
  readonly text: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}): FeishuCard | null {
  const meta = message.meta ?? {};
  switch (message.kind) {
    case 'watch.hit':
      return buildWatchHitCard(message.text, meta);
    case 'instruction.reply':
      return instructionReplyCard(message.text, meta);
    case 'instruction.async.started':
      return buildInstructionAsyncStartedCard(message.text, meta);
    case 'instruction.async.completed':
      return instructionAsyncCompletedCard(message.text, meta);
    case 'agent.paid_confirm':
      return buildAgentPaidConfirmCard(message.text, meta);
    case 'agent.tool_proposal':
      return buildAgentToolProposalCard(message.text, meta);
    case 'instruction.paid_confirm':
      return buildInstructionPaidConfirmCard(message.text, meta);
    default:
      return null;
  }
}
