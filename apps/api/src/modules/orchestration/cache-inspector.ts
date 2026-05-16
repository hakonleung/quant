/**
 * Cache inspector — finds work for the cron orchestrator
 * (`docs/modules/09-update-orchestration.md` §3).
 *
 * One scan loop emits two lists of *package-shaped* jobs:
 *   - `MetaJob` per code that needs basic-info enrichment OR financials
 *     refresh (or both — flags coalesce into a single envelope so the
 *     same code is only queued once).
 *   - `KlineJob` per code whose kline cache is missing or older than
 *     the latest tradable date.
 *
 * The "find" verbs are inputs to `CronOrchestrator.scan`; the cron
 * applies the `batchId` stamp and pushes via `addBulk`.
 */

/* eslint-disable no-restricted-globals -- Date arithmetic on persisted watermarks (not "now"). */
/* eslint-disable @typescript-eslint/consistent-type-assertions -- Arrow proxy.toJSON() is `any` from the library; narrow at the boundary. */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { isAShareCode, type StockMetaDto } from '@quant/shared';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { BlacklistStore } from '../blacklist/blacklist.store.js';
import { KlineReaderService } from '../kline/kline-reader.service.js';
import { ORCH_FLIGHT_CLIENT } from './flight.token.js';
import { arrowTableToStockMetaDtos } from '../stock-meta/domain/arrow-mapper.js';
import { LocalStockMetaWriterService } from '../stock-meta/local-stock-meta-writer.service.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';

/** Calendar-day staleness threshold for blacklisted A-share kline. */
const BLACKLIST_KLINE_REFRESH_DAYS = 10;
const DAY_MS = 86_400_000;
/**
 * Per-stock financials are considered stale (and re-queued for the
 * slow-path enricher) when their watermark crosses this many days,
 * matching what Python's `find_stale_financials` used to enforce.
 */
const STALE_FINANCIALS_MAX_AGE_DAYS = 7;
/** TTM gross-margin only reads the most recent year; older holes
 * don't gate the derived metric, so we cap the operating-cost check
 * at the last 4 quarterlies. */
const STALE_QUARTERS_CHECKED = 4;

export interface MetaScanItem {
  readonly code: string;
  readonly needBasic: boolean;
  readonly needFinancials: boolean;
}

@Injectable()
export class CacheInspector {
  private readonly logger = new Logger(CacheInspector.name);

  constructor(
    @Inject(ORCH_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(BlacklistStore) private readonly blacklist: BlacklistStore,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
    @Inject(KlineReaderService) private readonly klineReader: KlineReaderService,
    @Inject(LocalStockMetaWriterService)
    private readonly metaWriter: LocalStockMetaWriterService,
  ) {}

  /**
   * Find every code that needs meta work and pack each into a single
   * envelope keyed on `code`. `needBasic` and `needFinancials` flag the
   * sub-steps so the worker can short-circuit either half. Blacklisted
   * A-share codes are filtered out — they're skipped at the worker too,
   * but emitting fewer envelopes keeps the queue lean.
   */
  async findMetaWork(traceId: string): Promise<readonly MetaScanItem[]> {
    const [incompleteCodes, staleFinancialCodes] = await Promise.all([
      this.findIncompleteMetaCodes(traceId),
      this.findStaleFinancialCodes(traceId),
    ]);
    const merged = new Map<string, MetaScanItem>();
    for (const code of incompleteCodes) {
      merged.set(code, { code, needBasic: true, needFinancials: false });
    }
    for (const code of staleFinancialCodes) {
      const prev = merged.get(code);
      merged.set(code, {
        code,
        needBasic: prev?.needBasic ?? false,
        needFinancials: true,
      });
    }
    return Array.from(merged.values());
  }

  private async findIncompleteMetaCodes(traceId: string): Promise<readonly string[]> {
    // Read meta locally via LocalStockMetaAdapter (60s SWR cache);
    // saves the Flight round-trip every cron tick used to pay for
    // `list_stock_meta_all`.
    const rows = await this.stockMeta.listAll(traceId);
    return rows
      .filter((r) => r.industries === '')
      .filter((r) => !(isAShareCode(r.code) && this.blacklist.has(r.code)))
      .map((r) => r.code);
  }

  private async findStaleFinancialCodes(traceId: string): Promise<readonly string[]> {
    // Field-completeness + watermark check over the local meta universe —
    // mirrors the (now-removed) Python `find_stale_financials` op. The
    // logic is a pure filter, not a numerical algorithm, so co-locating
    // it with the reader avoids a Flight round-trip every cron tick.
    const metas = await this.stockMeta.listAll(traceId);
    const cutoff = Date.now() - STALE_FINANCIALS_MAX_AGE_DAYS * DAY_MS;
    const out: string[] = [];
    for (const meta of metas) {
      if (isAShareCode(meta.code) && this.blacklist.has(meta.code)) continue;
      if (isFinancialsStale(meta, cutoff)) out.push(meta.code);
    }
    return out;
  }

  /**
   * Synchronous bulk financials sync (8 quarters of `stock_yjbb_em` ⇒
   * one Flight call). Cheap full-market prepass — the per-code
   * `find_stale_financials` watermark is computed *after* this lands.
   */
  async syncBulkFinancials(traceId: string): Promise<{
    readonly fetched: number;
    readonly updated: number;
  }> {
    try {
      const result = await this.flight.doGet('bulk_sync_financials', {}, { traceId });
      // Python returns merged rows in STOCK_META_SCHEMA + counts in
      // schema metadata; storage is NestJS-owned, so persist locally.
      const rows = arrowTableToStockMetaDtos(result.value);
      if (rows.length > 0) {
        await this.metaWriter.upsertMetas(rows);
      }
      const meta = result.value.schema.metadata;
      return {
        fetched: readSchemaInt(meta, 'fetched_codes'),
        updated: readSchemaInt(meta, 'updated_codes', rows.length),
      };
    } catch (err) {
      this.logger.warn(
        `bulk_sync_financials failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { fetched: 0, updated: 0 };
    }
  }

  async findStaleKline(traceId: string): Promise<readonly string[]> {
    const [metas, latestTradeDay] = await Promise.all([
      this.stockMeta.listAll(traceId),
      this.fetchLatestTradeDay(traceId),
    ]);
    const codes = metas.map((m) => m.code);
    const watermarks = await this.klineReader.lastTradeDates(codes);
    interface Row {
      readonly code: string;
      readonly lastDate: string | null;
    }
    const rows: Row[] = codes.map((code) => {
      const ts = watermarks.get(code);
      return {
        code,
        lastDate: ts === undefined ? null : ts.toISOString().slice(0, 10),
      };
    });
    if (latestTradeDay === null) {
      this.logger.warn(`latest_trade_day_unavailable — skipping stale-kline scan`);
      return [];
    }
    const todayMs = Date.now();
    const stale = rows
      .filter((r) => r.lastDate === null || r.lastDate < latestTradeDay)
      .filter((r) => this.shouldSyncBlacklisted(r.code, r.lastDate, todayMs))
      .map((r) => r.code);
    this.logger.debug(
      `stale_kline_count=${String(stale.length)} latest_trade_day=${latestTradeDay}`,
    );
    return stale;
  }

  private shouldSyncBlacklisted(code: string, lastDate: string | null, todayMs: number): boolean {
    if (!isAShareCode(code) || !this.blacklist.has(code)) return true;
    if (lastDate === null) return true;
    const lastMs = Date.parse(`${lastDate}T00:00:00Z`);
    if (Number.isNaN(lastMs)) return true;
    const ageDays = Math.floor((todayMs - lastMs) / DAY_MS);
    return ageDays >= BLACKLIST_KLINE_REFRESH_DAYS;
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
 * Decode an Arrow `date32` cell into ISO `YYYY-MM-DD`. See the doc on
 * `apache-arrow` inconsistency notes in the historical commit log.
 */
function isFinancialsStale(meta: StockMetaDto, cutoffMs: number): boolean {
  // Field-completeness drives the list before the watermark — see the
  // original Python docstring on FinancialsService.find_stale_financials
  // for the rationale (total_share + operating_cost are both per-stock
  // slow-path outputs; bulk_refresh never fills them).
  if (meta.total_share === null) return true;
  if (meta.quarterlies.length > 0) {
    const recent = meta.quarterlies.slice(-STALE_QUARTERS_CHECKED);
    for (const q of recent) {
      if (q.operating_cost === null) return true;
    }
  }
  if (meta.financials_updated_at === null) return true;
  const ts = Date.parse(meta.financials_updated_at);
  if (!Number.isFinite(ts)) return true;
  return ts < cutoffMs;
}

function readSchemaInt(
  meta: ReadonlyMap<string, string> | Record<string, string> | null | undefined,
  key: string,
  fallback = 0,
): number {
  if (meta === null || meta === undefined) return fallback;
  const raw = meta instanceof Map ? meta.get(key) : (meta as Record<string, string>)[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

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
