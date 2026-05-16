/**
 * Pure rendering for `/ledger` (list). Empty snapshot returns the
 * "ledger is empty" tag; otherwise emits text + lark_md table sections.
 *
 * `dailyPctDisplay` arrives pre-formatted by the handler so the renderer
 * doesn't need a Decimal dependency. Matches the legacy
 * `LedgerInstructionHandler` output 1:1.
 */

import {
  okResult,
  okResultWithMeta,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type LedgerListResult = ResultOf<'ledger'>;

export function renderLedger(envelope: InstructionEnvelope<LedgerListResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { totalCount, entries } = envelope.data;
  if (totalCount === 0) return okResult('ledger is empty');

  const subheader = `ledger (last ${String(entries.length)} of ${String(totalCount)})`;
  const text = `${subheader}:\n${entries
    .map(
      (e) =>
        `  ${e.date}  pnl=${e.pnlAmount.padStart(10)}  pos=${e.closingPosition.padStart(12)}  pct=${e.dailyPctDisplay}`,
    )
    .join('\n')}`;
  return okResultWithMeta(text, {
    tableSections: [
      {
        columns: [
          { name: 'date', displayName: 'date', horizontalAlign: 'left', width: '110px' },
          { name: 'pnl', displayName: 'pnl', horizontalAlign: 'right', width: '110px' },
          { name: 'pos', displayName: 'pos', horizontalAlign: 'right', width: '120px' },
          { name: 'pct', displayName: 'pct%', horizontalAlign: 'right', width: '80px' },
        ],
        rows: entries.map((e) => ({
          date: e.date,
          pnl: e.pnlAmount,
          pos: e.closingPosition,
          pct: e.dailyPctDisplay,
        })),
      },
    ],
    tablesSubheader: subheader,
  });
}
