/**
 * `/screen` cell — natural-language stock screen via LLM + executor.
 *
 * Handler runs `ScreenService.runNl` and assembles the displayed-slice
 * stock-list rows via `StockListService.assembleRows`. Failures in
 * row assembly degrade `stockRows` to `null` (renderer falls back to
 * a code list) so a transient snapshot outage doesn't lose the screen
 * matches themselves.
 *
 * `QuantError` from `runNl` → `handler` error envelope (matches legacy
 * handler); other throws propagate to the async-job logger.
 *
 * No peek hook: NL-screen output isn't cached at the BE layer the way
 * sentiment / TA are, so the IM gate always shows the confirm card.
 */

import {
  InstructionDispatchError,
  QuantError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';

import { ScreenService } from '../../screen/screen.service.js';
import { StockListService } from '../../stock-list/stock-list.service.js';
import type { BeEnv } from '../be-types.js';
import { renderScreen } from './screen.render.js';

type ScreenResult = ResultOf<'screen'>;

const MAX_MATCHES_DISPLAY = 30;

export interface ScreenCellDeps {
  readonly screen: ScreenService;
  readonly stockList: StockListService;
}

export function buildScreenCell(deps: ScreenCellDeps): InstructionCell<BeEnv, 'screen'> {
  return {
    async handler(args, ctx): Promise<ScreenResult> {
      let result;
      try {
        result = await deps.screen.runNl(args.q, args.asof, {
          userId: ctx.userId,
          traceId: ctx.traceId,
        });
      } catch (err) {
        if (err instanceof QuantError) {
          throw new InstructionDispatchError('handler', err.message);
        }
        throw err;
      }
      const codes = result.matches.slice(0, MAX_MATCHES_DISPLAY).map((m) => m.code);
      if (codes.length === 0) {
        return {
          nl: result.nl,
          asof: result.asof,
          totalMatches: 0,
          displayedCount: 0,
          codes: [],
          stockRows: null,
        };
      }
      try {
        const out = await deps.stockList.assembleRows({
          kind: 'screen',
          codes,
          traceId: ctx.traceId,
        });
        return {
          nl: result.nl,
          asof: result.asof,
          totalMatches: result.matches.length,
          displayedCount: codes.length,
          codes,
          stockRows: out.rows,
        };
      } catch {
        return {
          nl: result.nl,
          asof: result.asof,
          totalMatches: result.matches.length,
          displayedCount: codes.length,
          codes,
          stockRows: null,
        };
      }
    },
    renderer(envelope) {
      return renderScreen(envelope);
    },
  };
}
