/**
 * FE shell wrapper around `feCenter.dispatch` — also fans out the
 * manifest-declared `revalidate` scopes after a successful handler.
 *
 * Every instruction lives on `feCenter` post-migration. The host
 * (`useTerminal`) routes every `runCommand` effect through here;
 * unknown ids surface as `not-found` envelopes that the renderer
 * paints red via `fallbackRenderer`.
 */

import {
  INSTRUCTION_MANIFEST,
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
 * Dispatch a command line through the FE center. Returns the rendered
 * `CommandRunOutput`; revalidate scopes for the resolved instruction
 * fire on success. Unknown / mis-typed ids surface as
 * `not-found` / `parse` error envelopes which the fallback renderer
 * paints as a red toast.
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

function manifestEntryOf(id: FeConfiguredId): CommandManifestEntry | undefined {
  return (INSTRUCTION_MANIFEST as Record<string, CommandManifestEntry | undefined>)[id];
}

function textErr(body: string): TermOutput {
  return { kind: 'text', status: 'err', tail: { body: paint(body, ANSI.red) } };
}
