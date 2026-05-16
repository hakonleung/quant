/**
 * FE `/ledger.remove` cell — thin proxy to BE.
 *
 * The legacy command surfaced a FE confirm widget before firing the
 * remove; the manifest now carries `doubleConfirm: 'destructive'` so
 * the IM gate handles confirmation, and the FE shell can layer a
 * confirm widget on top via a follow-up if/when desired. Cell handler
 * always fires through.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type LedgerRemoveResult = ResultOf<'ledger.remove'>;

export function buildLedgerRemoveCell(): InstructionCell<FeEnv, 'ledger.remove'> {
  return {
    async handler(args, ctx): Promise<LedgerRemoveResult> {
      const env = await ctx.api.invoke('ledger.remove', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      return textOk(`removed ${envelope.data.date}`);
    },
  };
}
