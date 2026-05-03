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

function parseDateCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // Arrow date32 decodes to a Date at UTC midnight.
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${String(y)}-${m}-${d}`;
  }
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
  if (typeof value === 'number') {
    // date32 is days since unix epoch.
    const ms = value * 86_400_000;
    const dt = new Date(ms);
    return parseDateCell(dt);
  }
  return null;
}
