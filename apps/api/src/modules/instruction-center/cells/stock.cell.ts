/**
 * `/stock` cell — A-share metadata search by code / name / pinyin.
 *
 * Handler: filters the metadata list against the lower-cased query
 * (codes match raw), tops out at `limit`, then joins with the latest
 * snapshot map to produce `StockListRow[]`. Renderer: `renderStock`.
 *
 * Snapshot fetch failures degrade gracefully — the row builder fills
 * every numeric field with `null` when no snapshot is available,
 * matching the legacy `StockInstructionHandler` behaviour.
 */

import type {
  InstructionCell,
  ResultOf,
  StockListRow,
  StockSnapshotDto,
} from '@quant/shared';

import { StockMetaService } from '../../stock-meta/stock-meta.service.js';
import type { BeEnv } from '../be-types.js';
import { renderStock } from './stock.render.js';

type StockSearchResult = ResultOf<'stock'>;

export interface StockCellDeps {
  readonly stockMeta: StockMetaService;
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

      let byCode: Map<string, StockSnapshotDto>;
      try {
        const snapshots = await deps.stockMeta.snapshotAll(ctx.traceId);
        byCode = new Map(snapshots.map((s) => [s.meta.code, s]));
      } catch {
        byCode = new Map();
      }
      const rows: StockListRow[] = matches.map((m) => buildRow(m.code, m.name, byCode.get(m.code)));
      return { query: args.q ?? '', rows };
    },
    renderer(envelope) {
      return renderStock(envelope);
    },
  };
}

function buildRow(code: string, name: string, snap: StockSnapshotDto | undefined): StockListRow {
  return {
    code,
    name,
    price: parseDecimal(snap?.price),
    chgPct: parseDecimal(snap?.returns.ret_1d),
    turnoverRate: null,
    turnover: null,
    consecUp: null,
    ret5d: parseDecimal(snap?.returns.ret_5d),
    ret10d: parseDecimal(snap?.returns.ret_10d),
    ret20d: parseDecimal(snap?.returns.ret_20d),
    ret90d: parseDecimal(snap?.returns.ret_90d),
    ret250d: parseDecimal(snap?.returns.ret_250d),
    mktCap: parseDecimal(snap?.derived.mkt_cap),
    floatMktCap: parseDecimal(snap?.derived.float_mkt_cap),
    peTtm: parseDecimal(snap?.derived.pe_ttm),
    peDynamic: parseDecimal(snap?.derived.pe_dynamic),
    pb: parseDecimal(snap?.derived.pb),
    peg: parseDecimal(snap?.derived.peg),
    grossMargin: parseDecimal(snap?.derived.gross_margin_ttm),
  };
}

function parseDecimal(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
