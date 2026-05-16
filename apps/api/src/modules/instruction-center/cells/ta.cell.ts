/**
 * `/ta <code>` cell — single-stock TA analysis.
 *
 * Handler: invokes `TaService.analyzeOne(code, fresh, ctx)` and returns
 * the typed `TaAnalysis`. `QuantError` becomes a `validation` envelope
 * (matches legacy handler); other throws propagate.
 *
 * Peek: when `fresh=false` and `TaService.getCached` returns a row, skip
 * the IM confirm card.
 */

import {
  InstructionDispatchError,
  QuantError,
  TaArgsSchema,
  type InstructionCell,
  type TaResult,
} from '@quant/shared';

import { TaService } from '../../ta/ta.service.js';
import type { BeEnv } from '../be-types.js';
import { renderTa } from './ta.render.js';

export interface TaCellDeps {
  readonly ta: TaService;
}

export function buildTaCell(deps: TaCellDeps): InstructionCell<BeEnv, 'ta'> {
  return {
    async handler(args, ctx): Promise<TaResult> {
      try {
        return await deps.ta.analyzeOne(args.code, args.fresh, {
          userId: ctx.userId,
          traceId: ctx.traceId,
        });
      } catch (err) {
        if (err instanceof QuantError) {
          throw new InstructionDispatchError('validation', err.message);
        }
        throw err;
      }
    },
    renderer(envelope) {
      return renderTa(envelope);
    },
    async peek(rawArgs, ctx) {
      const parsed = TaArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return false;
      if (parsed.data.fresh) return false;
      try {
        const cached = await deps.ta.getCached(parsed.data.code, ctx.traceId);
        return cached !== null;
      } catch {
        return false;
      }
    },
  };
}
