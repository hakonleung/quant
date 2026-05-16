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
 *
 * `lastNBulk` is the hot path for EQ.LIST and IM stock-list renders.
 * We cache the full-universe last-N result per `n` with a 60s SWR
 * window: kline parquets only mutate on the daily 15:15 BJT cron, so
 * staleness is bounded by the cache window, never by request latency.
 * Code-subset calls filter from the cached snapshot instead of issuing
 * a fresh DuckDB scan.
 */

import { Inject, Injectable } from '@nestjs/common';
import { type KlineBar } from '@quant/shared';

import type { TimeSeriesStore } from '../../common/storage/ports/time-series-store.port.js';
import type { ScreenRow } from '../screen/domain/pure/screen-eval.js';
import type { KlineRow } from './kline.row.js';
import { KLINE_TIME_SERIES_STORE } from './kline.token.js';

const BULK_CACHE_TTL_MS = 60_000;

interface BulkCacheEntry {
  readonly value: ReadonlyMap<string, readonly KlineBar[]>;
  readonly fetchedAt: number;
}

@Injectable()
export class KlineReaderService {
  private readonly bulkCache = new Map<number, BulkCacheEntry>();
  private readonly bulkInflight = new Map<number, Promise<ReadonlyMap<string, readonly KlineBar[]>>>();

  constructor(@Inject(KLINE_TIME_SERIES_STORE) private readonly store: TimeSeriesStore<KlineRow>) {}

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
    const universe = await this.bulkUniverse(n);
    const out: Record<string, readonly KlineBar[]> = {};
    if (codes.length === 0) {
      for (const [code, bars] of universe) out[code] = bars;
      return out;
    }
    for (const code of codes) {
      const bars = universe.get(code);
      if (bars !== undefined) out[code] = bars;
    }
    return out;
  }

  /** Test hook — drop the in-process bulk cache. */
  clearBulkCache(): void {
    this.bulkCache.clear();
  }

  private async bulkUniverse(n: number): Promise<ReadonlyMap<string, readonly KlineBar[]>> {
    const cached = this.bulkCache.get(n);
    if (cached !== undefined && Date.now() - cached.fetchedAt < BULK_CACHE_TTL_MS) {
      return cached.value;
    }
    const inflight = this.bulkInflight.get(n);
    if (inflight !== undefined) return inflight;
    const pending = this.scanUniverse(n).finally(() => {
      this.bulkInflight.delete(n);
    });
    this.bulkInflight.set(n, pending);
    const value = await pending;
    this.bulkCache.set(n, { value, fetchedAt: Date.now() });
    return value;
  }

  private async scanUniverse(n: number): Promise<ReadonlyMap<string, readonly KlineBar[]>> {
    const rows = await this.store.read({ tail: n });
    const out = new Map<string, KlineBar[]>();
    for (const row of rows) {
      const bar = rowToBar(row);
      const bucket = out.get(row.code);
      if (bucket === undefined) {
        out.set(row.code, [bar]);
      } else {
        bucket.push(bar);
      }
    }
    return out;
  }

  /**
   * Bulk read for the screen executor: trailing window over `codes`
   * between `start` and `end` (both inclusive), returning rows in the
   * raw qfq-field shape (`open_qfq`, `close_qfq`, …) plus a synthesised
   * `pct_chg_qfq = (close_qfq - prev close_qfq) / prev close_qfq` per
   * code. The first bar's `pct_chg_qfq` is `null`.
   *
   * Rows are already sorted by `(code asc, ts asc)` per the store
   * contract; we group by code without re-sorting.
   */
  async bulkRangeForScreen(
    codes: readonly string[],
    start: Date,
    end: Date,
  ): Promise<Record<string, readonly ScreenRow[]>> {
    if (codes.length === 0) return {};
    const rows = await this.store.read({ entityKeys: codes, start, end });
    const out: Record<string, ScreenRow[]> = {};
    let prevCode: string | null = null;
    let prevClose: number | null = null;
    for (const row of rows) {
      let pctChg: number | null = null;
      if (row.code === prevCode && prevClose !== null && prevClose > 0) {
        pctChg = (row.close_qfq - prevClose) / prevClose;
      }
      const bar = {
        trade_date: tsToIsoDate(row.ts),
        open_qfq: row.open_qfq,
        high_qfq: row.high_qfq,
        low_qfq: row.low_qfq,
        close_qfq: row.close_qfq,
        volume: row.volume,
        amount: row.amount,
        turnover_rate: row.turnover_rate,
        ma5: row.ma5,
        ma10: row.ma10,
        ma20: row.ma20,
        ma60: row.ma60,
        pct_chg_qfq: pctChg,
      } as ScreenRow;
      const bucket = out[row.code];
      if (bucket === undefined) {
        out[row.code] = [bar];
      } else {
        bucket.push(bar);
      }
      prevCode = row.code;
      prevClose = row.close_qfq;
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

// Trust the store contract: `KlineRow` is built by `DuckDBParquetTimeSeriesStore`
// which already normalises types per the column spec. Re-validating each bar
// through zod added ~70% to assembleRows CPU time at 5500×30 bars and protected
// against a contract we ourselves write — internal call, no zod (CLAUDE.md §1.3).
function rowToBar(row: KlineRow): KlineBar {
  return {
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
  };
}

function tsToIsoDate(ts: Date): string {
  const y = ts.getUTCFullYear().toString().padStart(4, '0');
  const m = (ts.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = ts.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}
