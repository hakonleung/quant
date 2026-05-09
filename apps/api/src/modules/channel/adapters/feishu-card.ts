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

interface FeishuCard {
  readonly config: { readonly wide_screen_mode: boolean };
  readonly header: {
    readonly template: 'red' | 'green' | 'grey' | 'blue' | 'orange';
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
  };
  readonly elements: readonly unknown[];
}

const PRICE_PREFIX: Readonly<Record<string, string>> = { a: '¥', hk: 'HK$', us: '$' };

const PCT_RE = /[+-]?\d+(?:\.\d+)?%/u;
const NEG_LEAD_RE = /^-\d/u;

/** Feishu rejects card text elements above ~5k chars; truncate generously below the limit. */
const MAX_BODY_CHARS = 3000;
const TRUNCATE_SUFFIX = '\n…(truncated)';

function truncateForCard(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
}

function metaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
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

export function buildWatchHitCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuCard {
  const market = metaString(meta, 'market') ?? 'a';
  const code = metaString(meta, 'code') ?? '';
  const name = metaString(meta, 'name') ?? code;
  const last = metaString(meta, 'last');
  const prefix = PRICE_PREFIX[market] ?? '';
  const priceLine = last !== null ? `${prefix}${last}` : '';

  // Pull the % line (2nd line) and condition list (3rd) from the
  // pre-rendered text payload so we don't re-implement formatting.
  const lines = text.split('\n');
  const pctLine = lines[1] ?? '';
  const condsLine = lines[2] ?? '';
  const direction = inferDirection(pctLine);
  const summaryMd =
    `<font color='${DIR_TO_COLOR[direction]}'>${pctText(pctLine)}</font>` +
    (priceLine.length > 0 ? `   ${priceLine}` : '');

  return {
    config: { wide_screen_mode: true },
    header: {
      template: DIR_TO_TEMPLATE[direction],
      title: { tag: 'plain_text', content: `WATCH · [${market}]${name} ${code}`.trim() },
    },
    elements: watchHitElements(summaryMd, condsLine),
  };
}

/** Generic builder for arbitrary push kinds — title in the header, body
 *  as a single lark_md block. Picks a neutral tone when the kind is
 *  unknown. */
export function buildFeishuCard(message: {
  readonly title?: string;
  readonly text: string;
  readonly kind?: string;
}): FeishuCard {
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
): FeishuCard {
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
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: truncateForCard(stripSlackMrkdwn(text)) } },
    ],
  };
}

/** "Started" card emitted right after an async instruction is queued. */
export function buildInstructionAsyncStartedCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuCard {
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `▶ /${idLabel} queued` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: truncateForCard(stripSlackMrkdwn(text)) } },
    ],
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
): FeishuCard {
  const ok = meta['ok'] === true;
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  const code = metaString(meta, 'code');
  const durationMs = metaNumber(meta, 'durationMs');
  const headerTitle = ok
    ? `✓ /${idLabel} done`
    : code !== null
      ? `✗ /${idLabel} (${code})`
      : `✗ /${idLabel} failed`;
  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: truncateForCard(stripSlackMrkdwn(text)) } },
  ];
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
 * Choose a card for the message kind, or return null to fall back to
 * the stripped-mrkdwn plain-text path.
 */
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
      return buildInstructionReplyCard(message.text, meta);
    case 'instruction.async.started':
      return buildInstructionAsyncStartedCard(message.text, meta);
    case 'instruction.async.completed':
      return buildInstructionAsyncCompletedCard(message.text, meta);
    default:
      return null;
  }
}
