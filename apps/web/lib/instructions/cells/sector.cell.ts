/**
 * FE `/sector` cell — list sectors visible to the caller.
 *
 * Renderer prints a compact table; commit isn't interactive (sector
 * show/publish ops are typed as separate ids).
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type SectorListResult = ResultOf<'sector'>;

export function buildSectorCell(): InstructionCell<FeEnv, 'sector'> {
  return {
    async handler(args, ctx): Promise<SectorListResult> {
      const env = await ctx.api.invoke('sector', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      if (envelope.data.rows.length === 0) {
        return textOk('no sectors — try `sector.add sector=...`');
      }
      const lines: string[] = [paint('ID         NAME             KIND      CODES  PUB', ANSI.bold)];
      for (const r of envelope.data.rows) {
        lines.push(
          `${pad(r.id, 10)} ${pad(r.name, 16)} ${pad(r.isOwn ? 'own' : 'pub', 8)} ${pad(String(r.codeCount), 5)}  ${r.published ? 'Y' : 'N'}`,
        );
      }
      return textOk(lines.join('\n'));
    },
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
