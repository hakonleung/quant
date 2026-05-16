/**
 * `/ledger.add` cell — upsert one ledger entry by date.
 *
 * Mirrors the legacy `POST /api/ledger/entries` write path: pass-through
 * to `LedgerService.create`, which handles the closingPosition-chain
 * anchor invariant for the first entry. Returns the persisted entry so
 * the renderer can echo the canonical (server-validated) values.
 */

import {
  InstructionDispatchError,
  QuantError,
  okResult,
  type InstructionCell,
  type InstructionResult,
  type ResultOf,
} from '@quant/shared';

import { LedgerService } from '../../ledger/ledger.service.js';
import type { BeEnv } from '../be-types.js';

type LedgerAddResult = ResultOf<'ledger.add'>;

export interface LedgerAddCellDeps {
  readonly ledger: LedgerService;
}

export function buildLedgerAddCell(deps: LedgerAddCellDeps): InstructionCell<BeEnv, 'ledger.add'> {
  return {
    async handler(args, ctx): Promise<LedgerAddResult> {
      try {
        const entry = await deps.ledger.create(ctx.userId, {
          date: args.date,
          pnlAmount: args.pnlAmount,
          ...(args.closingPosition !== undefined
            ? { closingPosition: args.closingPosition }
            : {}),
        });
        return {
          date: entry.date,
          pnlAmount: entry.pnlAmount,
          closingPosition: entry.closingPosition ?? null,
        };
      } catch (err) {
        if (err instanceof QuantError) {
          throw new InstructionDispatchError('handler', err.message);
        }
        throw err;
      }
    },
    renderer(envelope): InstructionResult {
      if (!envelope.ok) {
        return { ok: false, error: envelope.error };
      }
      const r = envelope.data;
      const closing = r.closingPosition === null ? '' : `  closing=${r.closingPosition}`;
      return okResult(`added ${r.date}  pnl=${r.pnlAmount}${closing}`);
    },
  };
}
