/**
 * FE `/watch.add` cell — thin proxy for the manifest-shaped add.
 *
 * The legacy guided form is gone — invoke with `watch.add code=600519
 * market=a group=default` directly. Richer per-condition settings
 * (thresholds / intervals) need the manifest schema to expand first;
 * see `docs/integrations/instruction-center-migration.md`.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type WatchAddResult = ResultOf<'watch.add'>;

export function buildWatchAddCell(): InstructionCell<FeEnv, 'watch.add'> {
  return {
    async handler(args, ctx): Promise<WatchAddResult> {
      const env = await ctx.api.invoke('watch.add', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      return textOk(`watch task w${String(r.idx)} created: ${r.market}/${r.code} → ${r.groupName}`);
    },
  };
}
