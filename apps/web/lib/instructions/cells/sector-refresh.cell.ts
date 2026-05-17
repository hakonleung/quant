/**
 * FE `/sector.refresh <id>` cell — re-run a dynamic sector's NL screen.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type SectorRefreshResult = ResultOf<'sector.refresh'>;

export function buildSectorRefreshCell(): InstructionCell<FeEnv, 'sector.refresh'> {
  return {
    async handler(args, ctx): Promise<SectorRefreshResult> {
      const env = await ctx.api.invoke('sector.refresh', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const s = envelope.data;
      return textOk(
        `refreshed sector ${s.name}: codes=${String(s.count)} chgPct=${String(s.chgPct ?? '—')}`,
      );
    },
  };
}
