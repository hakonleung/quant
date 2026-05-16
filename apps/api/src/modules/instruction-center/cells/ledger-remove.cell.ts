/**
 * `/ledger.remove` cell — drop one ledger entry by date.
 *
 * Pass-through to `LedgerService.remove`. The legacy FE terminal
 * surfaces a confirm widget before this fires; the IM surface relies
 * on the manifest's `doubleConfirm: 'destructive'` gate.
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

type LedgerRemoveResult = ResultOf<'ledger.remove'>;

export interface LedgerRemoveCellDeps {
  readonly ledger: LedgerService;
}

export function buildLedgerRemoveCell(
  deps: LedgerRemoveCellDeps,
): InstructionCell<BeEnv, 'ledger.remove'> {
  return {
    async handler(args, ctx): Promise<LedgerRemoveResult> {
      try {
        await deps.ledger.remove(ctx.userId, args.date);
        return { date: args.date };
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
      return okResult(`removed ${envelope.data.date}`);
    },
  };
}
