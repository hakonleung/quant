/**
 * FE `/screen` cell — natural-language stock screen.
 *
 * Two phases driven by `args.confirm`:
 *   1. Without confirm → handler throws `confirm-required`; renderer
 *      surfaces a paid-confirm widget that re-dispatches with `confirm=1`.
 *   2. With confirm → invoke BE, render a selectable matches widget
 *      (stockRows from the manifest payload).
 *
 * Syntax change from the legacy command: the redundant `nl` keyword
 * is gone — `screen <query>` is enough. Manifest's `q` arg comes from
 * the joined positional tail (binding handled by the cell handler so
 * the schema's required `q` field is populated without a manifest-level
 * positional declaration, which would conflict with the bare-query
 * use case).
 */

import {
  InstructionDispatchError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import {
  canceledResolution,
  confirmPrompt,
  interactive,
  selectableList,
  textErr,
  textOk,
} from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type ScreenResult = ResultOf<'screen'>;

export function buildScreenCell(): InstructionCell<FeEnv, 'screen'> {
  return {
    async handler(args, ctx): Promise<ScreenResult> {
      if (args.confirm !== true) {
        throw new InstructionDispatchError(
          'confirm-required',
          JSON.stringify({ q: args.q, asof: args.asof ?? null }),
        );
      }
      const env = await ctx.api.invoke('screen', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        if (envelope.error.code === 'confirm-required') {
          const { q, asof } = parseConfirm(envelope.error.message);
          const tail = asof === null ? '' : ` asof=${asof}`;
          return interactive(
            confirmPrompt({
              title: `screen "${q}" (paid)`,
              danger: true,
              onYes: () => ({
                kind: 'command',
                line: `screen q=${quote(q)} confirm=1${tail}`,
              }),
              onNo: () => canceledResolution,
            }),
          );
        }
        return textErr(envelope.error.message);
      }
      const r = envelope.data;
      if (r.codes.length === 0) {
        return textOk(`no matches for "${r.nl}"`);
      }
      const rows: { code: string; name: string }[] =
        r.stockRows !== null
          ? r.stockRows.map((row) => ({ code: row.code, name: row.name ?? row.code }))
          : r.codes.map((code) => ({ code, name: code }));
      return interactive(
        selectableList({
          title: `screen "${r.nl}"  ·  ${String(r.totalMatches)} match(es)  ·  asof ${r.asof}`,
          items: rows,
          columns: [
            { key: 'code', header: 'CODE', max: 8 },
            { key: 'name', header: 'NAME', max: 16 },
          ],
          onCommit: (s) => ({ kind: 'command', line: `stock.info ${String(s.code)}` }),
        }),
      );
    },
  };
}

function parseConfirm(raw: string): { q: string; asof: string | null } {
  try {
    const p = JSON.parse(raw) as { q?: unknown; asof?: unknown };
    const q = typeof p.q === 'string' ? p.q : '';
    const asof = typeof p.asof === 'string' ? p.asof : null;
    return { q, asof };
  } catch {
    return { q: '', asof: null };
  }
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
