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
    readonly template: 'red' | 'green' | 'grey' | 'blue';
    readonly title: { readonly tag: 'plain_text'; readonly content: string };
  };
  readonly elements: ReadonlyArray<unknown>;
}

interface WatchHitMeta {
  readonly market?: string;
  readonly code?: string;
  readonly name?: string;
  readonly last?: string;
  readonly userId?: string;
}

const PRICE_PREFIX: Readonly<Record<string, string>> = { a: '¥', hk: 'HK$', us: '$' };

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

/**
 * Build the watch.hit card from `meta`. The text body still carries the
 * full Slack-formatted payload, so we re-derive the user-visible bits
 * from text when meta lacks something.
 */
export function buildWatchHitCard(text: string, meta: WatchHitMeta): FeishuCard {
  const market = typeof meta.market === 'string' ? meta.market : 'a';
  const code = typeof meta.code === 'string' ? meta.code : '';
  const name = typeof meta.name === 'string' ? meta.name : code;
  const last = typeof meta.last === 'string' ? meta.last : null;
  const prefix = PRICE_PREFIX[market] ?? '';
  const priceLine = last !== null ? `${prefix}${last}` : '';

  // Pull the % line (2nd line) and condition list (3rd) from the
  // pre-rendered text payload so we don't re-implement formatting.
  const lines = text.split('\n');
  const pctLine = lines[1] ?? '';
  const condsLine = lines[2] ?? '';
  const isUp = pctLine.includes('large_red_square') || pctLine.startsWith('+');
  const isDown = pctLine.includes('large_green_square') || /^-\d/.test(pctLine.trim());
  const headerTpl: FeishuCard['header']['template'] = isUp ? 'red' : isDown ? 'green' : 'grey';

  const cleanPct = stripSlackMrkdwn(pctLine).trim();
  const summaryColor = isUp ? 'red' : isDown ? 'green' : 'grey';
  const summaryMd =
    `**${name}** \`${code}\`\n` +
    `<font color='${summaryColor}'>${cleanPct}</font>` +
    (priceLine.length > 0 ? `   ${priceLine}` : '');

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: summaryMd } },
  ];
  if (condsLine.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: stripSlackMrkdwn(condsLine) }],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: headerTpl,
      title: { tag: 'plain_text', content: `WATCH · ${name} ${code}`.trim() },
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
}): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: message.title ?? message.kind ?? 'NOTICE' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: stripSlackMrkdwn(message.text) } },
    ],
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
  if (message.kind === 'watch.hit') {
    const meta = (message.meta ?? {}) as WatchHitMeta;
    return buildWatchHitCard(message.text, meta);
  }
  return null;
}
