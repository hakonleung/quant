/**
 * FE `/ledger` (list) cell — thin proxy to BE.
 *
 * Renderer formats the most-recent-first list as a fixed-width table.
 * Empty ledger gets a friendly hint instead of an empty table.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type LedgerListResult = ResultOf<'ledger'>;

export function buildLedgerCell(): InstructionCell<FeEnv, 'ledger'> {
  return {
    async handler(args, ctx): Promise<LedgerListResult> {
      const env = await ctx.api.invoke('ledger', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      if (r.totalCount === 0) {
        return textOk('ledger is empty — `ledger.add <date> <pnl> [closing]`');
      }
      const lines: string[] = [paint('DATE        PNL          PCT       CLOSING', ANSI.bold)];
      for (const e of r.entries) {
        const pnlNum = Number(e.pnlAmount);
        const pnlColor = pnlNum > 0 ? ANSI.green : pnlNum < 0 ? ANSI.red : ANSI.gray;
        lines.push(
          `${e.date}  ${paint(pad(e.pnlAmount, 11), pnlColor)}  ${pad(e.dailyPctDisplay, 7)}  ${pad(e.closingPosition, 10)}`,
        );
      }
      return textOk(lines.join('\n'));
    },
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
