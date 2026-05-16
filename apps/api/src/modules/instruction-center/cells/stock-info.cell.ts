/**
 * `/stock.info` cell — composite info view for one code.
 *
 * Pulls meta from `StockMetaService.get`, the latest snapshot from
 * `snapshotAll` (filtered), and the most recent 30 daily bars from
 * `KlineReaderService.lastNForCode`. Combined into one typed payload
 * so the FE can render header + table + sparkline without a follow-up
 * round-trip.
 *
 * Snapshot lookup degrades gracefully — a transient snapshot outage
 * returns `null` for that field; meta + bars stay populated.
 */

import {
  InstructionDispatchError,
  QuantError,
  type InstructionCell,
  type InstructionResult,
  type ResultOf,
  type StockSnapshotDto,
} from '@quant/shared';

import { KlineReaderService } from '../../kline/kline-reader.service.js';
import { StockMetaService } from '../../stock-meta/stock-meta.service.js';
import type { BeEnv } from '../be-types.js';

type StockInfoResult = ResultOf<'stock.info'>;

const RECENT_BARS = 30;

export interface StockInfoCellDeps {
  readonly stockMeta: StockMetaService;
  readonly kline: KlineReaderService;
}

export function buildStockInfoCell(
  deps: StockInfoCellDeps,
): InstructionCell<BeEnv, 'stock.info'> {
  return {
    async handler(args, ctx): Promise<StockInfoResult> {
      let meta;
      try {
        meta = await deps.stockMeta.get(args.code, ctx.traceId);
      } catch (err) {
        if (err instanceof QuantError && err.code === 'STOCK_NOT_FOUND') {
          throw new InstructionDispatchError('not-found', err.message);
        }
        throw err;
      }
      let snapshot: StockSnapshotDto | null = null;
      try {
        const all = await deps.stockMeta.snapshotAll(ctx.traceId);
        snapshot = all.find((s) => s.meta.code === args.code) ?? null;
      } catch {
        snapshot = null;
      }
      const recentBars = await deps.kline.lastNForCode(args.code, RECENT_BARS);
      return { meta, snapshot, recentBars: [...recentBars] };
    },
    renderer(envelope): InstructionResult {
      if (!envelope.ok) return { ok: false, error: envelope.error };
      const r = envelope.data;
      const lines: string[] = [
        `${r.meta.code}  ${r.meta.name}`,
        `industry: ${r.meta.industries.length > 0 ? r.meta.industries : '—'}`,
      ];
      if (r.snapshot !== null) {
        lines.push(`price: ${String(r.snapshot.price ?? '—')}`);
      }
      const last = r.recentBars.at(-1);
      if (last !== undefined) {
        lines.push(
          `asof ${last.date}  O/H/L/C ${String(last.open)}/${String(last.high)}/${String(last.low)}/${String(last.close)}`,
        );
      }
      return { ok: true, output: { text: lines.join('\n') } };
    },
  };
}
