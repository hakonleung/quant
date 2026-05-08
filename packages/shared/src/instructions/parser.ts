/**
 * Pure first-token parser shared by the BE IM listener and any future
 * FE delegating consumer. Splits "<id> <rest>" — the per-spec argv
 * tokenizer (positional / k=v) lives on each side because BE handlers
 * need zod coercion and FE handlers need the terminal's `parseArgv`
 * tied to xterm-style flags.
 *
 * `requirePrefix: true` (IM mode) demands a leading `/` so casual
 * Slack/Feishu chat doesn't trigger any handler. Term mode passes
 * `false` because it already lives behind a prompt.
 */

import { instructionId, isInstructionId, type InstructionId } from './id.js';

export type ParseFailure = 'no-prefix' | 'not-found' | 'empty';

export type ParseOutcome =
  | { readonly ok: true; readonly id: InstructionId; readonly rest: string }
  | { readonly ok: false; readonly reason: ParseFailure };

export interface ParseOptions {
  readonly requirePrefix?: boolean;
}

export function parseInstructionLine(
  text: string,
  knownIds: ReadonlySet<string>,
  options: ParseOptions = {},
): ParseOutcome {
  let body = text.trim();
  if (body.length === 0) return { ok: false, reason: 'empty' };

  if (options.requirePrefix === true) {
    if (!body.startsWith('/')) return { ok: false, reason: 'no-prefix' };
    body = body.slice(1).trimStart();
    if (body.length === 0) return { ok: false, reason: 'empty' };
  }

  // Split on the first whitespace run. We accept tab + space.
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(body);
  if (match === null) return { ok: false, reason: 'empty' };
  const head = match[1] ?? '';
  const rest = (match[2] ?? '').trim();

  if (!isInstructionId(head)) return { ok: false, reason: 'not-found' };
  if (!knownIds.has(head)) return { ok: false, reason: 'not-found' };

  return { ok: true, id: instructionId(head), rest };
}
