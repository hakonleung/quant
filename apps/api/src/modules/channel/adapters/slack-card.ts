/**
 * Slack Block Kit payload builders. Mirrors `feishu-card.ts` for the
 * Slack channel — keyed off the same `kind` strings so the IM listener
 * doesn't need to know which adapter renders the reply.
 *
 * Why not share with feishu-card: Block Kit and Feishu's interactive
 * card schemas have completely different shapes (Slack uses
 * `section`/`header`/`mrkdwn`, Feishu uses `lark_md` + a `header.template`
 * colour enum). A common abstraction would just be a wrapper polymorphism
 * — we're better off with two flat templates per CLAUDE.md §2.5.2.
 */

import { stripSlackMrkdwn } from './feishu-card.js';

export interface SlackBlocks {
  readonly blocks: readonly unknown[];
}

interface SlackOutboundLike {
  readonly title?: string;
  readonly text: string;
  readonly kind?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

const MAX_SECTION_CHARS = 3000; // Slack rejects section text > ~3000 chars
const TRUNCATE_SUFFIX = '\n…(truncated)';

function truncateForBlock(text: string): string {
  if (text.length <= MAX_SECTION_CHARS) return text;
  return text.slice(0, MAX_SECTION_CHARS - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
}

function metaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function metaNumber(meta: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function header(title: string): unknown {
  return {
    type: 'header',
    text: { type: 'plain_text', text: title, emoji: true },
  };
}

function mrkdwnSection(text: string): unknown {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: truncateForBlock(text) },
  };
}

function contextNote(text: string): unknown {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  };
}

/**
 * The Slack version of `watch.hit`. The Feishu side strips the Slack
 * mrkdwn for plain text; here we keep it (Slack renders `*bold*` natively)
 * and just wrap it in blocks so `text` is preserved for notifications.
 */
export function buildWatchHitBlocks(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): SlackBlocks {
  const rawHits = meta['hits'];
  const hitTexts: string[] = Array.isArray(rawHits)
    ? rawHits.flatMap((e): string[] => {
        if (e === null || typeof e !== 'object') return [];
        const t = (e as Record<string, unknown>)['text'];
        return typeof t === 'string' ? [t] : [];
      })
    : [text];

  if (hitTexts.length <= 1) {
    const single = hitTexts[0] ?? text;
    const lines = single.split('\n');
    const titleLine = lines[0] ?? 'WATCH';
    const body = lines.slice(1).join('\n').trim();
    const blocks: unknown[] = [header(stripSlackMrkdwn(titleLine))];
    if (body.length > 0) blocks.push(mrkdwnSection(body));
    return { blocks };
  }

  const blocks: unknown[] = [header(`WATCH · ${String(hitTexts.length)} hits`)];
  for (const hitText of hitTexts) {
    blocks.push(mrkdwnSection(hitText));
  }
  return { blocks };
}

export function buildInstructionReplyBlocks(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): SlackBlocks {
  const ok = meta['ok'] === true;
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  const code = metaString(meta, 'code');
  const headerTitle = ok
    ? `✓ /${idLabel}`
    : code !== null
      ? `✗ /${idLabel} (${code})`
      : `✗ /${idLabel}`;
  return {
    blocks: [header(headerTitle), mrkdwnSection(text)],
  };
}

export function buildInstructionAsyncStartedBlocks(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): SlackBlocks {
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  return {
    blocks: [header(`▶ /${idLabel} queued`), mrkdwnSection(text)],
  };
}

export function buildInstructionAsyncCompletedBlocks(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): SlackBlocks {
  const ok = meta['ok'] === true;
  const idLabel = metaString(meta, 'instructionId') ?? 'instruction';
  const code = metaString(meta, 'code');
  const durationMs = metaNumber(meta, 'durationMs');
  const headerTitle = ok
    ? `✓ /${idLabel} done`
    : code !== null
      ? `✗ /${idLabel} (${code})`
      : `✗ /${idLabel} failed`;
  const blocks: unknown[] = [header(headerTitle), mrkdwnSection(text)];
  if (durationMs !== null) blocks.push(contextNote(`took ${(durationMs / 1000).toFixed(2)}s`));
  return { blocks };
}

/**
 * Choose blocks for the message kind, or return null to fall back to
 * the plain-text `text` payload.
 */
export function pickBlocks(message: SlackOutboundLike): SlackBlocks | null {
  const meta = message.meta ?? {};
  switch (message.kind) {
    case 'watch.hit':
      return buildWatchHitBlocks(message.text, meta);
    case 'instruction.reply':
      return buildInstructionReplyBlocks(message.text, meta);
    case 'instruction.async.started':
      return buildInstructionAsyncStartedBlocks(message.text, meta);
    case 'instruction.async.completed':
      return buildInstructionAsyncCompletedBlocks(message.text, meta);
    default:
      return null;
  }
}
