/**
 * FE `/ledger.add` cell — thin proxy to BE.
 *
 * Legacy syntax `ledger add <date> <pnl> [closing]` lands here via the
 * manifest's positional binding (`['date', 'pnlAmount', 'closingPosition']`).
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type LedgerAddResult = ResultOf<'ledger.add'>;

export function buildLedgerAddCell(): InstructionCell<FeEnv, 'ledger.add'> {
  return {
    async handler(args, ctx): Promise<LedgerAddResult> {
      const env = await ctx.api.invoke('ledger.add', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      const closing = r.closingPosition === null ? '' : `  closing=${r.closingPosition}`;
      return textOk(`added ${r.date}  pnl=${r.pnlAmount}${closing}`);
    },
  };
}
