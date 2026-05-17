/**
 * FE `/ping` cell — thin proxy to the BE debug latency probe.
 *
 * Round-trips through `POST /api/instructions/ping`; the BE handler
 * is only registered when `INSTRUCTIONS_DEBUG_ENABLED=1`, so the cell
 * surfaces a clear handler error otherwise.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textErr, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type PingResult = ResultOf<'ping'>;

export function buildPingCell(): InstructionCell<FeEnv, 'ping'> {
  return {
    async handler(args, ctx): Promise<PingResult> {
      const env = await ctx.api.invoke('ping', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) return textErr(`ping: ${envelope.error.message}`);
      return textOk(envelope.data.text);
    },
  };
}
