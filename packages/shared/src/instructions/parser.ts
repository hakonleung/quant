/**
 * Pure first-token parser shared by the BE IM listener and any future
 * FE delegating consumer. Splits "<id> <rest>" — the per-spec argv
 * tokenizer (positional / k=v) lives on each side because BE handlers
 * need zod coercion and FE handlers need the terminal's `parseArgv`
 * tied to xterm-style flags.
 *
 * `knownIds` maps every accepted token (canonical id, ASCII alias, or
 * IM-only human alias such as Chinese) to its canonical InstructionId.
 * The lookup is a single Map.get so non-ASCII aliases work without
 * touching the id regex.
 *
 * `requirePrefix: true` (legacy / explicit IM mode) demands a leading
 * `/`. Term mode passes `false` because it already lives behind a prompt.
 */

import { instructionId, type InstructionId } from './id.js';

export type ParseFailure = 'no-prefix' | 'not-found' | 'empty';

export type ParseOutcome =
  | { readonly ok: true; readonly id: InstructionId; readonly rest: string }
  | { readonly ok: false; readonly reason: ParseFailure };

export interface ParseOptions {
  readonly requirePrefix?: boolean;
}

export function parseInstructionLine(
  text: string,
  knownIds: ReadonlyMap<string, string>,
  options: ParseOptions = {},
): ParseOutcome {
  let body = text.trim();
  if (body.length === 0) return { ok: false, reason: 'empty' };

  if (options.requirePrefix === true) {
    if (!body.startsWith('/')) return { ok: false, reason: 'no-prefix' };
    body = body.slice(1).trimStart();
    if (body.length === 0) return { ok: false, reason: 'empty' };
  } else if (body.startsWith('/')) {
    // Strip optional leading `/` for backward compatibility; bare tokens also accepted.
    body = body.slice(1).trimStart();
    if (body.length === 0) return { ok: false, reason: 'empty' };
  }

  // Split on the first whitespace run. We accept tab + space.
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(body);
  if (match === null) return { ok: false, reason: 'empty' };
  const head = match[1] ?? '';
  const rest = (match[2] ?? '').trim();

  // Subcommand resolution: when `<head> <sub> ...` and `<head>.<sub>` is a
  // registered id (ASCII alias / canonical), prefer it over the bare head.
  // This lets the FE terminal's `sector show <id>` syntax map to the
  // backend's dotted `sector.show` handler without a separate registry
  // concept. `head` itself does not need to be registered for the dotted
  // form to win; if `head.sub` is unknown we fall back to head-only.
  if (rest.length > 0) {
    const subMatch = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(rest);
    if (subMatch !== null) {
      const sub = subMatch[1] ?? '';
      const subRest = (subMatch[2] ?? '').trim();
      const dotted = `${head}.${sub}`;
      const dottedCanonical = knownIds.get(dotted);
      if (dottedCanonical !== undefined) {
        return { ok: true, id: instructionId(dottedCanonical), rest: subRest };
      }
    }
  }

  const canonical = knownIds.get(head);
  if (canonical === undefined) return { ok: false, reason: 'not-found' };

  return { ok: true, id: instructionId(canonical), rest };
}
