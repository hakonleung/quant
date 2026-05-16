/**
 * `/ledger.analyze` cell — LLM-driven ledger review.
 *
 * Handler invokes `LedgerService.analyze(userId, traceId, fresh)` and
 * returns the typed `LedgerAnalysis`. `QuantError` maps to `handler`
 * (matches the legacy handler); other throws propagate.
 *
 * No peek hook: the legacy handler didn't expose `peekImConfirmBypass`
 * either — the LLM call always runs (cache lookup happens inside
 * `LedgerService.analyze` so `fresh=false` cache hits still skip the
 * paid round-trip, but only after the IM confirm card).
 */

import {
  InstructionDispatchError,
  QuantError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';

import { LedgerService } from '../../ledger/ledger.service.js';
import type { BeEnv } from '../be-types.js';
import { renderLedgerAnalyze } from './ledger-analyze.render.js';

type LedgerAnalyzeResult = ResultOf<'ledger.analyze'>;

export interface LedgerAnalyzeCellDeps {
  readonly ledger: LedgerService;
}

export function buildLedgerAnalyzeCell(
  deps: LedgerAnalyzeCellDeps,
): InstructionCell<BeEnv, 'ledger.analyze'> {
  return {
    async handler(args, ctx): Promise<LedgerAnalyzeResult> {
      try {
        return await deps.ledger.analyze(ctx.userId, ctx.traceId, args.fresh);
      } catch (err) {
        if (err instanceof QuantError) {
          throw new InstructionDispatchError('handler', err.message);
        }
        throw err;
      }
    },
    renderer(envelope) {
      return renderLedgerAnalyze(envelope);
    },
  };
}
