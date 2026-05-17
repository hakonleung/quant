/**
 * FE `/watch.group` cell — toggle a watch group's enabled state.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type WatchGroupResult = ResultOf<'watch.group'>;

export function buildWatchGroupCell(): InstructionCell<FeEnv, 'watch.group'> {
  return {
    async handler(args, ctx): Promise<WatchGroupResult> {
      const env = await ctx.api.invoke('watch.group', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      return textOk(`watch group ${r.name} ${r.enabled ? 'resumed' : 'paused'}`);
    },
  };
}
