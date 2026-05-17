/**
 * FE `/channel.echo` cell — thin proxy to the BE debug channel echo.
 *
 * Round-trips through `POST /api/instructions/channel.echo`; the BE
 * handler is only registered when `INSTRUCTIONS_DEBUG_ENABLED=1`. The
 * BE echoes back the channel context it observed for this request.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textErr, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type ChannelEchoResult = ResultOf<'channel.echo'>;

export function buildChannelEchoCell(): InstructionCell<FeEnv, 'channel.echo'> {
  return {
    async handler(args, ctx): Promise<ChannelEchoResult> {
      const env = await ctx.api.invoke('channel.echo', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) return textErr(`channel.echo: ${envelope.error.message}`);
      return textOk(envelope.data.text);
    },
  };
}
