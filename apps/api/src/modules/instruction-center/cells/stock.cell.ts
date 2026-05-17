/**
 * `/stock` cell — A-share metadata search by code / name / pinyin.
 *
 * Handler: filters the metadata list against the lower-cased query
 * (codes match raw), tops out at `limit`, then hands the resulting
 * codes to `StockListService.assembleRows` so the row shape — and the
 * snapshot + kline-derived fields (turnoverRate, turnover, consecUp)
 * — match every other stock-list surface (sector / watch / screen).
 *
 * If row assembly throws (snapshot or kline outage), we degrade to a
 * code-only row list so the search itself still returns something
 * useful in IM.
 */

import { emptyStockListRow, type InstructionCell, type ResultOf, type StockListRow } from '@quant/shared';

import { StockListService } from '../../stock-list/stock-list.service.js';
import { StockMetaService } from '../../stock-meta/stock-meta.service.js';
import type { BeEnv } from '../be-types.js';
import { renderStock } from './stock.render.js';

type StockSearchResult = ResultOf<'stock'>;

export interface StockCellDeps {
  readonly stockMeta: StockMetaService;
  readonly stockList: StockListService;
}

export function buildStockCell(deps: StockCellDeps): InstructionCell<BeEnv, 'stock'> {
  return {
    async handler(args, ctx): Promise<StockSearchResult> {
      const all = await deps.stockMeta.listAll(ctx.traceId);
      const q = (args.q ?? '').toLowerCase();
      const matches =
        q.length === 0
          ? all.slice(0, args.limit)
          : all
              .filter(
                (m) =>
                  m.code.includes(q) ||
                  m.name.toLowerCase().includes(q) ||
                  m.name_pinyin.toLowerCase().includes(q),
              )
              .slice(0, args.limit);
      if (matches.length === 0) return { query: args.q ?? '', rows: [] };

      const codes = matches.map((m) => m.code);
      try {
        const out = await deps.stockList.assembleRows({
          kind: 'screen',
          codes,
          traceId: ctx.traceId,
        });
        return { query: args.q ?? '', rows: out.rows };
      } catch {
        const fallback: StockListRow[] = matches.map((m) => emptyRow(m.code, m.name));
        return { query: args.q ?? '', rows: fallback };
      }
    },
    renderer(envelope) {
      return renderStock(envelope);
    },
  };
}

function emptyRow(code: string, name: string): StockListRow {
  return emptyStockListRow(code, name);
}
