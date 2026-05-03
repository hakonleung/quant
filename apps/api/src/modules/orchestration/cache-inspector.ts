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

const SHANGHAI_TZ = 'Asia/Shanghai';

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
    const result = await this.flight.doGet('list_kline_watermarks', {}, { traceId });
    const table = result.value;
    const today = todayInShanghai();
    const stale: string[] = [];
    for (let i = 0; i < table.numRows; i++) {
      const proxy = table.get(i);
      if (proxy === null) continue;
      const row = proxy.toJSON() as { code: unknown; last_date: unknown };
      if (typeof row.code !== 'string') continue;
      const last = parseDateCell(row.last_date);
      if (last === null || last < today) {
        stale.push(row.code);
      }
    }
    this.logger.debug(`stale_kline_count=${String(stale.length)} today=${today}`);
    return stale;
  }
}

function todayInShanghai(): string {
  // Format as YYYY-MM-DD using Shanghai timezone.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
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
