/**
 * Read side of the kline pipeline.
 *
 * Surfaces the local NestJS `TimeSeriesStore` to controllers/services
 * that previously called the Python `list_kline_for_code` Flight op.
 * Output is the `KlineBar` DTO shared across BFF + FE so call sites
 * can swap their underlying source without changing what they emit.
 *
 * Local-first by design: once the cross-process flip lands and Python
 * stops persisting parquet, this service is the *only* read path.
 * Until then it can be paired with a Flight fallback at the call site.
 */

import { Inject, Injectable } from '@nestjs/common';
import { KlineBarSchema, type KlineBar } from '@quant/shared';

import type { TimeSeriesStore } from '../../common/storage/ports/time-series-store.port.js';
import type { KlineRow } from './kline.row.js';
import { KLINE_TIME_SERIES_STORE } from './kline.token.js';

@Injectable()
export class KlineReaderService {
  constructor(
    @Inject(KLINE_TIME_SERIES_STORE) private readonly store: TimeSeriesStore<KlineRow>,
  ) {}

  /** Last `n` bars for a single code, oldest first. Empty array when absent. */
  async lastNForCode(code: string, n: number): Promise<readonly KlineBar[]> {
    const rows = await this.store.read({ entityKeys: [code], tail: n });
    return rows.map(rowToBar);
  }

  /**
   * Last `n` bars for many codes; returns `Record<code, bar[]>` (codes
   * with no rows are absent from the map).
   *
   * Empty `codes` means "full universe": every code with at least one
   * bar in the local store. The controller's `/api/kline/bulk` uses this
   * to render the list panel without the caller having to enumerate the
   * universe.
   */
  async lastNBulk(
    codes: readonly string[],
    n: number,
  ): Promise<Record<string, readonly KlineBar[]>> {
    const query = codes.length === 0 ? { tail: n } : { entityKeys: codes, tail: n };
    const rows = await this.store.read(query);
    const out: Record<string, KlineBar[]> = {};
    for (const row of rows) {
      const bar = rowToBar(row);
      const bucket = out[row.code];
      if (bucket === undefined) {
        out[row.code] = [bar];
      } else {
        bucket.push(bar);
      }
    }
    return out;
  }

  /** Last known trade date for a code, or `null` if no bars exist. */
  async lastTradeDate(code: string): Promise<Date | null> {
    return this.store.lastTimestamp(code);
  }

  /** Batched watermark lookup; missing codes are absent from the map. */
  async lastTradeDates(codes: readonly string[]): Promise<ReadonlyMap<string, Date>> {
    return this.store.lastTimestamps(codes);
  }
}

function rowToBar(row: KlineRow): KlineBar {
  return KlineBarSchema.parse({
    date: tsToIsoDate(row.ts),
    open: row.open_qfq,
    high: row.high_qfq,
    low: row.low_qfq,
    close: row.close_qfq,
    volume: row.volume,
    turnover: row.amount,
    turnoverRate: row.turnover_rate,
    ma5: row.ma5,
    ma10: row.ma10,
    ma20: row.ma20,
    ma60: row.ma60,
  });
}

function tsToIsoDate(ts: Date): string {
  const y = ts.getUTCFullYear().toString().padStart(4, '0');
  const m = (ts.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = ts.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}
