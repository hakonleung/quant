/**
 * FE `/watch.remove` cell — thin proxy by w-index id.
 *
 * Manifest takes `{ id: 'w1' }`. Legacy `watch rm <market> <code>`
 * syntax is gone.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type WatchRemoveResult = ResultOf<'watch.remove'>;

export function buildWatchRemoveCell(): InstructionCell<FeEnv, 'watch.remove'> {
  return {
    async handler(args, ctx): Promise<WatchRemoveResult> {
      const env = await ctx.api.invoke('watch.remove', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      return textOk(`removed watch w${String(envelope.data.idx)}`);
    },
  };
}
