/**
 * FE shell wrapper around `feCenter.dispatch` — also fans out the
 * manifest-declared `revalidate` scopes after a successful handler.
 *
 * Hosts (`useTerminal`) check `feCenterHasHead(line)` before dispatching;
 * misses fall through to the legacy `runCommand(line, ctx, registry)`
 * path so migration is incremental.
 */

import {
  INSTRUCTION_MANIFEST,
  tokenize,
  type CommandManifestEntry,
} from '@quant/shared';
import {
  ANSI,
  paint,
  type Event as TerminalEvent,
} from '@quant/terminal';

import { feCenter, type FeConfiguredId } from './fe-center.js';
import type { FeCtx, TermHost, TermOutput } from './fe-types.js';

/**
 * Return true when the first token of `line` (after optional leading
 * `/`) resolves to an instruction configured on `feCenter`. Includes
 * dotted subcommand resolution (`sector show s1` → `sector.show`).
 */
export function feCenterCanDispatch(line: string): boolean {
  const head = peekHead(line);
  if (head === null) return false;
  if (feCenter.has(head)) return true;
  // Dotted subcommand: `sector show` → `sector.show`.
  const sub = peekSub(line);
  if (sub !== null && feCenter.has(`${head}.${sub}`)) return true;
  // Aliases: `feCenter.has('股票')` is true if 'stock' is configured
  // and the manifest entry declares the alias. The center's internal
  // `dispatch` resolves aliases via its own alias index, so we
  // mirror that here by walking the manifest.
  for (const entry of allManifestEntries()) {
    if (!feCenter.has(entry.id)) continue;
    if ((entry.aliases ?? []).includes(head)) return true;
  }
  return false;
}

/**
 * Dispatch a command line through the FE center. The caller is
 * responsible for falling back to the legacy registry path when
 * `feCenterCanDispatch(line)` returns false.
 *
 * Output is the rendered `CommandRunOutput`; revalidate scopes for
 * the resolved instruction fire on success.
 */
export async function feDispatch(
  line: string,
  ctx: FeCtx,
  host: TermHost = { stockIndex: ctx.stockIndex },
): Promise<TermOutput> {
  return feCenter.dispatch(line, ctx, host, {
    onResolved: (id, envelope) => {
      if (envelope.ok !== true) return;
      const entry = manifestEntryOf(id);
      const scopes = entry?.revalidate ?? [];
      for (const scope of scopes) ctx.stores.revalidate?.(scope);
    },
    fallbackRenderer: (err) => textErr(`${err.code}: ${err.message}`),
  });
}

/**
 * Translate the rendered `TermOutput` into the terminal engine's
 * `Event[]` (same shape `runCommand` produces). Hosts dispatch the
 * events into the reducer.
 */
export function termOutputToEvents(out: TermOutput): readonly TerminalEvent[] {
  if (out.kind === 'interactive') {
    return [{ kind: 'startInteractive', widget: out.widget }];
  }
  if (out.kind === 'engine') return out.events;
  return [{ kind: 'result', entry: { body: out.tail.body, status: out.status } }];
}

function peekHead(line: string): string | null {
  const trimmed = line.trim();
  const stripped = trimmed.startsWith('/') ? trimmed.slice(1).trimStart() : trimmed;
  if (stripped.length === 0) return null;
  const tokens = tokenize(stripped);
  return tokens[0] ?? null;
}

function peekSub(line: string): string | null {
  const trimmed = line.trim();
  const stripped = trimmed.startsWith('/') ? trimmed.slice(1).trimStart() : trimmed;
  const tokens = tokenize(stripped);
  return tokens[1] ?? null;
}

function manifestEntryOf(id: FeConfiguredId): CommandManifestEntry | undefined {
  return (INSTRUCTION_MANIFEST as Record<string, CommandManifestEntry | undefined>)[id];
}

function allManifestEntries(): readonly CommandManifestEntry[] {
  return Object.values(INSTRUCTION_MANIFEST) as readonly CommandManifestEntry[];
}

function textErr(body: string): TermOutput {
  return { kind: 'text', status: 'err', tail: { body: paint(body, ANSI.red) } };
}
