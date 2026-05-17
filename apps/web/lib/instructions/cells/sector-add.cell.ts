/**
 * FE `/sector.add` cell — thin proxy that upserts a `Sector` payload.
 *
 * Migration note: the legacy `sector add` opened a multi-step
 * interactive form. With the cell model the form lives elsewhere
 * (or callers pass `sector=<json>` on the CLI / IM card). This cell
 * is the thin server-side write only.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type SectorAddResult = ResultOf<'sector.add'>;

export function buildSectorAddCell(): InstructionCell<FeEnv, 'sector.add'> {
  return {
    async handler(args, ctx): Promise<SectorAddResult> {
      const env = await ctx.api.invoke('sector.add', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const s = envelope.data;
      return textOk(`saved sector ${s.id}  "${s.name}"  codes=${String(s.count)}`);
    },
  };
}
