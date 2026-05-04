/**
 * Cache inspector — finds work for the cron orchestrator
 * (`docs/modules/09-update-orchestration.md` §3).
 *
 * Two queries, one Flight call each:
 *
 * - `findIncompleteMeta` — scans `list_stock_meta_all`, returns codes
 *   whose `industries` is empty (i.e. only the bulk endpoint has touched
 *   them so XQ enrichment is still owed).
 * - `findStaleKline` — scans `list_kline_watermarks`, returns codes whose
 *   K-line cache is empty or older than today's Beijing-time date.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ORCH_FLIGHT_CLIENT } from './flight.token.js';
import { arrowTableToStockMetaDtos } from '../stock-meta/domain/arrow-mapper.js';

@Injectable()
export class CacheInspector {
  private readonly logger = new Logger(CacheInspector.name);

  constructor(@Inject(ORCH_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  async findIncompleteMeta(traceId: string): Promise<readonly string[]> {
    const result = await this.flight.doGet('list_stock_meta_all', {}, { traceId });
    const rows = arrowTableToStockMetaDtos(result.value);
    return rows.filter((r) => r.industries === '').map((r) => r.code);
  }

  /**
   * Codes whose financials track is missing or stale (>7 days).
   * Authoritative answer comes from the python service so the watermark
   * (`financials_updated_at` etc.) stays single-sourced; the inspector
   * just relays.
   */
  async findStaleFinancials(traceId: string): Promise<readonly string[]> {
    try {
      const result = await this.flight.doGet(
        'find_stale_financials',
        { max_age_days: 7 },
        { traceId },
      );
      const out: string[] = [];
      const table = result.value;
      for (let i = 0; i < table.numRows; i++) {
        const proxy = table.get(i);
        if (proxy === null) continue;
        const raw = proxy.toJSON() as { code: unknown };
        if (typeof raw.code === 'string') out.push(raw.code);
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `find_stale_financials failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Synchronous bulk financials sync (8 quarters of `stock_yjbb_em` ⇒
   * one Flight call). Returns the python service's report so the cron
   * can include the counts in its scan summary; never throws — a
   * py-flight failure is logged and surfaced as `(0, 0)` so the rest
   * of the scan can still progress.
   */
  async syncBulkFinancials(traceId: string): Promise<{
    readonly fetched: number;
    readonly updated: number;
  }> {
    try {
      const result = await this.flight.doGet('bulk_sync_financials', {}, { traceId });
      const table = result.value;
      if (table.numRows === 0) return { fetched: 0, updated: 0 };
      const proxy = table.get(0);
      if (proxy === null) return { fetched: 0, updated: 0 };
      const raw = proxy.toJSON() as { fetched_codes?: unknown; updated_codes?: unknown };
      return {
        fetched: typeof raw.fetched_codes === 'number' ? raw.fetched_codes : 0,
        updated: typeof raw.updated_codes === 'number' ? raw.updated_codes : 0,
      };
    } catch (err) {
      this.logger.warn(
        `bulk_sync_financials failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { fetched: 0, updated: 0 };
    }
  }

  async findStaleKline(traceId: string): Promise<readonly string[]> {
    const [watermarks, latestTradeDay] = await Promise.all([
      this.flight.doGet('list_kline_watermarks', {}, { traceId }),
      this.fetchLatestTradeDay(traceId),
    ]);
    const table = watermarks.value;
    interface Row {
      readonly code: string;
      readonly lastDate: string | null;
    }
    const rows: Row[] = [];
    for (let i = 0; i < table.numRows; i++) {
      const proxy = table.get(i);
      if (proxy === null) continue;
      const raw = proxy.toJSON() as { code: unknown; last_date: unknown };
      if (typeof raw.code !== 'string') continue;
      rows.push({ code: raw.code, lastDate: parseDateCell(raw.last_date) });
    }
    // Authoritative threshold = the latest trading day whose bar is
    // expected to be available right now (akshare calendar +
    // post-close gating, owned by Python). On weekends, holidays, or
    // mid-session the threshold is the previous trade day, so a code
    // synced to that date is correctly considered fresh and skips the
    // queue. Without this gate, every cron tick on a non-trading day
    // re-enqueued every code forever.
    if (latestTradeDay === null) {
      this.logger.warn(`latest_trade_day_unavailable — skipping stale-kline scan`);
      return [];
    }
    const stale = rows
      .filter((r) => r.lastDate === null || r.lastDate < latestTradeDay)
      .map((r) => r.code);
    this.logger.debug(
      `stale_kline_count=${String(stale.length)} latest_trade_day=${latestTradeDay}`,
    );
    return stale;
  }

  private async fetchLatestTradeDay(traceId: string): Promise<string | null> {
    try {
      const result = await this.flight.doGet('get_latest_trade_day', {}, { traceId });
      const table = result.value;
      if (table.numRows === 0) return null;
      const proxy = table.get(0);
      if (proxy === null) return null;
      const row = proxy.toJSON() as { trade_date?: unknown };
      return parseDateCell(row.trade_date);
    } catch (err) {
      this.logger.warn(
        `get_latest_trade_day failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

/**
 * Decode an Arrow `date32` cell into ISO `YYYY-MM-DD`.
 *
 * `apache-arrow` is inconsistent about what `proxy.toJSON()` emits for
 * date32 columns: some bindings hand back a `Date`, some a string,
 * some the raw `days since epoch`, and some the `ms since epoch`. The
 * old "always treat number as days" branch silently turned today's
 * watermarks (emitted as ms by the binding we're on) into year-56000
 * dates, which then sorted *before* `latest_trade_day` and re-flagged
 * every code as stale every cron tick — the symptom the user reported
 * as "kline keeps re-syncing".
 *
 * Heuristic mirrors `kline/domain/arrow-mapper.ts`: anything bigger
 * than 1e8 is already milliseconds, smaller is days.
 */
export function parseDateCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${String(y)}-${m}-${d}`;
  }
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
  if (typeof value === 'number') {
    const ms = value > 1e8 ? value : value * 86_400_000;
    return parseDateCell(new Date(ms));
  }
  if (typeof value === 'bigint') {
    return parseDateCell(Number(value));
  }
  return null;
}
