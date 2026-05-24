/**
 * `/watch.add <code> [market=a] group=<name>` cell.
 *
 * Handler resolves a stock name (best-effort lookup → falls back to the
 * raw code), creates the watch task, and returns the assigned w-index
 * + the canonical task summary. `QuantError` on create surfaces as a
 * `validation` envelope; the legacy "code not valid for market" check
 * also folds into `validation`.
 *
 * Renderer emits the single-line confirmation the IM/term UI shows.
 */

import {
  InstructionDispatchError,
  QuantError,
  inferMarketFromCode,
  okResult,
  type InstructionCell,
  type InstructionEnvelope,
  type WatchAddResult,
} from '@quant/shared';

import type { WatchTaskCreate } from '../../watch/dto/watch.dto.js';
import { WatchService } from '../../watch/watch.service.js';
import type { BeEnv, ImOutput } from '../be-types.js';

export interface WatchAddCellDeps {
  readonly watch: WatchService;
}

export function buildWatchAddCell(
  deps: WatchAddCellDeps,
): InstructionCell<BeEnv, 'watch.add'> {
  return {
    async handler(args, ctx): Promise<WatchAddResult> {
      if (inferMarketFromCode(args.code) !== args.market) {
        throw new InstructionDispatchError(
          'validation',
          `code ${args.code} is not valid for market ${args.market}`,
        );
      }
      let stockName = args.name;
      if (stockName === undefined) {
        try {
          const basic = await deps.watch.lookup(args.market, args.code);
          stockName = basic.name;
        } catch {
          stockName = args.code;
        }
      }
      const payload: WatchTaskCreate = {
        market: args.market,
        code: args.code,
        name: stockName,
        groupName: args.group,
        remaining: null,
        notifySlack: true,
        enabled: true,
      };
      let task;
      try {
        task = await deps.watch.create(ctx.userId, payload);
      } catch (err) {
        if (err instanceof QuantError) {
          throw new InstructionDispatchError('validation', err.message);
        }
        throw err;
      }
      return {
        idx: task.idx,
        market: args.market,
        code: args.code,
        name: stockName,
        groupName: args.group,
      };
    },
    renderer(envelope) {
      return renderWatchAdd(envelope);
    },
  };
}

export function renderWatchAdd(envelope: InstructionEnvelope<WatchAddResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const r = envelope.data;
  return okResult(
    `w${String(r.idx)} added: ${r.market}:${r.code} "${r.name}" in group ${r.groupName}`,
  );
}
