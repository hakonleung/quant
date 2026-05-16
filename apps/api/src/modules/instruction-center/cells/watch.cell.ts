/**
 * `/watch` (list) cell — list every registered watch task with the
 * stock-table rows for its A-share members.
 *
 * Handler: pulls `WatchService.list(userId)`, projects each task to
 * `WatchListTask`, then optimistically fetches A-share snapshot rows
 * via `StockListService.assembleRows`. Snapshot fetch failures degrade
 * to `stockRows: null`, matching the legacy `WatchInstructionHandler`
 * graceful fallback.
 */

import type {
  InstructionCell,
  ResultOf,
  WatchListTask,
} from '@quant/shared';

import { StockListService } from '../../stock-list/stock-list.service.js';
import { WatchService } from '../../watch/watch.service.js';
import type { BeEnv } from '../be-types.js';
import { renderWatch } from './watch.render.js';

type WatchListResult = ResultOf<'watch'>;

export interface WatchCellDeps {
  readonly watch: WatchService;
  readonly stockList: StockListService;
}

export function buildWatchCell(deps: WatchCellDeps): InstructionCell<BeEnv, 'watch'> {
  return {
    async handler(_args, ctx): Promise<WatchListResult> {
      const tasks = await deps.watch.list(ctx.userId);
      if (tasks.length === 0) return { tasks: [], stockRows: null };

      const projected: WatchListTask[] = tasks.map((t) => ({
        idx: t.idx,
        market: t.market,
        code: t.code,
        name: t.name,
        groupName: t.groupName,
        enabled: t.enabled,
        hitCount: t.hitCount,
      }));

      const aCodes = [...new Set(tasks.filter((t) => t.market === 'a').map((t) => t.code))];
      if (aCodes.length === 0) return { tasks: projected, stockRows: null };

      try {
        const out = await deps.stockList.assembleRows({
          kind: 'watch',
          codes: aCodes,
          traceId: ctx.traceId,
        });
        return { tasks: projected, stockRows: out.rows };
      } catch {
        return { tasks: projected, stockRows: null };
      }
    },
    renderer(envelope) {
      return renderWatch(envelope);
    },
  };
}
