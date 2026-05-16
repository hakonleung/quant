/**
 * FE `/update` cell — thin proxy to the BE update cell, which
 * coalesces with the in-flight daily scan and returns the trace id.
 *
 * Manifest declares `revalidate: ['all']` so the shell drops every
 * client-side cache on success — the gateway streams new rows over
 * the socket queue snapshot as the scan completes.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textErr, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type UpdateResult = ResultOf<'update'>;

export function buildUpdateCell(): InstructionCell<FeEnv, 'update'> {
  return {
    async handler(_args, ctx): Promise<UpdateResult> {
      const env = await ctx.api.invoke('update', {}, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) return textErr(`update: ${envelope.error.message}`);
      const { started, traceId } = envelope.data;
      return textOk(
        started
          ? `update dispatched traceId=${traceId}`
          : `update coalesced with in-flight scan traceId=${traceId}`,
      );
    },
  };
}
