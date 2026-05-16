/**
 * `/ledger` cell — list the recent N entries.
 *
 * Handler: pulls the enriched snapshot, slices the tail by `limit`,
 * reverses to most-recent-first, and projects to `LedgerListEntry` —
 * pre-formatting `derivedDailyPct` so the renderer stays Decimal-free.
 * Renderer: `renderLedger` (pure).
 */

import type { InstructionCell, LedgerListEntry, ResultOf } from '@quant/shared';

import { LedgerService } from '../../ledger/ledger.service.js';
import type { BeEnv } from '../be-types.js';
import { renderLedger } from './ledger.render.js';

type LedgerListResult = ResultOf<'ledger'>;

export interface LedgerCellDeps {
  readonly ledger: LedgerService;
}

export function buildLedgerCell(deps: LedgerCellDeps): InstructionCell<BeEnv, 'ledger'> {
  return {
    async handler(args, ctx): Promise<LedgerListResult> {
      const enriched = await deps.ledger.enriched(ctx.userId);
      if (enriched.length === 0) {
        return { totalCount: 0, entries: [] };
      }
      const tail = enriched.slice(-args.limit).reverse();
      const entries: LedgerListEntry[] = tail.map((e) => ({
        date: e.date,
        pnlAmount: e.pnlAmount,
        closingPosition: e.derivedClosingPosition,
        dailyPctDisplay: formatPct(e.derivedDailyPct),
      }));
      return { totalCount: enriched.length, entries };
    },
    renderer(envelope) {
      return renderLedger(envelope);
    },
  };
}

/**
 * Force daily-pct to 2 decimals + sign. `derivedDailyPct` is a
 * pre-formatted decimal string (e.g. "1.234"); reparse so we can round
 * without pulling Decimal.js into the cell.
 */
function formatPct(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return `${raw}%`;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}
