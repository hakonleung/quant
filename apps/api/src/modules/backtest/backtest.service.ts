/**
 * Backtest orchestration (event-study signal evaluation).
 *
 * Two paths, both end at the Python `evaluate_signal` Flight op:
 *
 *   - `evaluateSignals(req, traceId)` — primitive: caller already has
 *     a `(signalDate, code)` stream. Fetches forward-adjusted opens
 *     for every distinct code over the window the holdings require,
 *     ships everything to Python, returns the distribution payload.
 *
 *   - `evaluateScreen(req, traceId)` — orchestration: runs the screen
 *     DSL once per weekday in `[startDate, endDate]`, then folds the
 *     daily matches into the primitive. Python remains compute-only
 *     (CLAUDE.md §2.1) — NestJS owns reading parquet and the per-day
 *     screen loop.
 *
 * Why fetch klines here rather than have Python read parquet: see
 * docs/perf/storage-unify-rollout.md — Python no longer touches the
 * disk in this codebase; all kline IO is in the NestJS-side
 * `KlineReaderService`.
 */

import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  BacktestEvaluateResponseSchema,
  type BacktestEvaluateResponse,
  type BacktestEvaluateScreenRequest,
  type BacktestEvaluateSignalsRequest,
  type BacktestSignal,
  type ScreenPlanAst,
} from '@quant/shared';
import { type Table } from 'apache-arrow';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { KlineReaderService } from '../kline/kline-reader.service.js';
import { KLINE_DATA_DIR } from '../kline/kline.token.js';
import { ScreenExecService } from '../screen/screen-exec.service.js';
import { BacktestCacheStore, responseKey, screenBaseKey } from './backtest-cache.store.js';
import { BACKTEST_FLIGHT_CLIENT } from './backtest.token.js';

/* eslint-disable no-restricted-globals --
 * `Date` is used here for pure ISO ↔ ms conversion + day-of-week math
 * (no current-time reads), mirroring screen-exec.service.ts. The Clock
 * port doesn't help when there is no "now" to inject. */

/**
 * Calendar buffer added on top of `max(holding)` so the exit bar lookup
 * has room for weekends/holidays. 1.6× covers a typical 252/365 ratio
 * plus a holiday week; matches the constant used in ScreenExecService.
 */
const HOLDING_TO_CALENDAR_MULTIPLIER = 1.6;
const CALENDAR_BUFFER_DAYS = 10;

export interface ScreenProgressEvent {
  /** 'screen' = mid-loop after each weekday; 'flight' = loop done, Python call about to start. */
  readonly phase: 'screen' | 'flight';
  /** ISO date of the weekday just processed; null on the final 'flight' tick. */
  readonly day: string | null;
  /** Weekdays processed so far. */
  readonly runDays: number;
  /** Total weekdays in the [start,end] window. */
  readonly totalDays: number;
  /** Weekdays that produced ≥ 1 match so far. */
  readonly matchedDays: number;
  /** Cumulative (signalDate, code) signals collected so far. */
  readonly signals: number;
}

export type ScreenProgressCallback = (event: ScreenProgressEvent) => void;

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private readonly klineParquetGlob: string;
  private connPromise: Promise<DuckDBConnection> | null = null;

  constructor(
    @Inject(BACKTEST_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(KlineReaderService) private readonly klineReader: KlineReaderService,
    @Inject(ScreenExecService) private readonly screenExec: ScreenExecService,
    @Inject(KLINE_DATA_DIR) klineDataRoot: string,
    @Inject(BacktestCacheStore) private readonly cache: BacktestCacheStore,
  ) {
    this.klineParquetGlob = join(klineDataRoot, 'kline', '*.parquet');
  }

  private async connection(): Promise<DuckDBConnection> {
    this.connPromise ??= (async (): Promise<DuckDBConnection> => {
      const instance = await DuckDBInstance.create(':memory:');
      return instance.connect();
    })();
    return this.connPromise;
  }

  /**
   * Latest trade day represented in the kline parquet (max ts). The
   * value is the single source of truth for cache invalidation: a row
   * is fresh iff its stamped `last_trade_day` equals the current value.
   * Cached per request-batch (resolved once per evaluate call so the
   * 250-day loop only pays one DuckDB roundtrip).
   */
  private async latestKlineTradeDay(): Promise<Date> {
    const conn = await this.connection();
    const sql = `SELECT MAX(ts) AS max_ts FROM read_parquet('${this.klineParquetGlob}')`;
    const result = await conn.runAndReadAll(sql);
    const rows = result.getRowObjects();
    const raw = rows[0]?.['max_ts'];
    if (raw === null || raw === undefined) {
      throw new Error('kline parquet has no rows; cannot derive latest_trade_day');
    }
    return new Date(String(raw));
  }

  async evaluateSignals(
    req: BacktestEvaluateSignalsRequest,
    traceId: string,
  ): Promise<BacktestEvaluateResponse> {
    const currentTradeDay = await this.latestKlineTradeDay();
    return this.runEvaluate(req.signals, req.holdings, traceId, currentTradeDay);
  }

  /**
   * Cache-only read. Returns the fully-assembled response if a prior
   * `evaluateScreen` for the same (plan, window, holdings) finished
   * within the current trading day; `null` otherwise. The controller
   * surfaces `null` as HTTP 404 (mirrors `GET /api/sentiment/analyze_one`).
   */
  async getCachedScreen(
    req: BacktestEvaluateScreenRequest,
  ): Promise<BacktestEvaluateResponse | null> {
    const currentTradeDay = await this.latestKlineTradeDay();
    return this.cache.getResponse(responseKey(req), currentTradeDay);
  }

  async evaluateScreen(
    req: BacktestEvaluateScreenRequest,
    traceId: string,
    onProgress?: ScreenProgressCallback,
  ): Promise<BacktestEvaluateResponse> {
    const startMs = isoDateToMs(req.startDate);
    const endMs = isoDateToMs(req.endDate);
    if (startMs > endMs) {
      throw new Error(`startDate (${req.startDate}) must be <= endDate (${req.endDate})`);
    }
    // Resolve once. Used as the freshness stamp for every cache hit/set
    // in this call, so we never race the kline cron mid-loop.
    const currentTradeDay = await this.latestKlineTradeDay();

    // Response-level cache hit: skip the screen loop AND the Flight
    // round-trip entirely. Stream callers don't get progress events on
    // a full hit, which is fine — it returns in <50 ms anyway.
    const resKey = responseKey(req);
    const cached = await this.cache.getResponse(resKey, currentTradeDay);
    if (cached !== null) {
      this.logger.log(
        `evaluate_screen response_cache_hit lastTradeDay=` +
          `${currentTradeDay.toISOString().slice(0, 10)} trace_id=${traceId}`,
      );
      return cached;
    }

    const totalDays = countWeekdays(startMs, endMs);
    const signals = await this.collectSignals(req, totalDays, currentTradeDay, onProgress);

    this.logger.log(
      `evaluate_screen signals=${String(signals.length)} ` +
        `totalDays=${String(totalDays)} ` +
        `lastTradeDay=${currentTradeDay.toISOString().slice(0, 10)} trace_id=${traceId}`,
    );
    onProgress?.({
      phase: 'flight',
      day: null,
      runDays: totalDays,
      totalDays,
      matchedDays: countMatchedDays(signals),
      signals: signals.length,
    });

    const response =
      signals.length === 0
        ? emptyResponse(req.holdings)
        : await this.runEvaluate(signals, req.holdings, traceId, currentTradeDay);
    await this.cache.setResponse(resKey, response, currentTradeDay);
    await this.cache.flush();
    return response;
  }

  private async collectSignals(
    req: BacktestEvaluateScreenRequest,
    totalDays: number,
    currentTradeDay: Date,
    onProgress: ScreenProgressCallback | undefined,
  ): Promise<BacktestSignal[]> {
    const startMs = isoDateToMs(req.startDate);
    const endMs = isoDateToMs(req.endDate);
    const planBaseKey = screenBaseKey(req);
    const signals: BacktestSignal[] = [];
    let runDays = 0;
    let matchedDays = 0;
    let cacheHits = 0;
    for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
      const dow = new Date(ms).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      runDays += 1;
      const asof = msToIsoDate(ms);
      const codes = await this.screenForDay(planBaseKey, req, asof, currentTradeDay, () => {
        cacheHits += 1;
      });
      if (codes.length > 0) {
        matchedDays += 1;
        for (const code of codes) signals.push({ signalDate: asof, code });
      }
      onProgress?.({
        phase: 'screen',
        day: asof,
        runDays,
        totalDays,
        matchedDays,
        signals: signals.length,
      });
    }
    if (cacheHits > 0) {
      this.logger.log(
        `screen_cache_hit hits=${String(cacheHits)}/${String(runDays)} ` +
          `plan_base_key=${planBaseKey.slice(0, 12)}`,
      );
    }
    await this.cache.flush();
    return signals;
  }

  private async screenForDay(
    planBaseKey: string,
    req: BacktestEvaluateScreenRequest,
    asof: string,
    currentTradeDay: Date,
    onHit: () => void,
  ): Promise<readonly string[]> {
    const cached = await this.cache.getScreen(planBaseKey, asof, currentTradeDay);
    if (cached !== null) {
      onHit();
      return cached;
    }
    const planForDay: ScreenPlanAst = { ...req.screenPlan, asof };
    const res = await this.screenExec.execute(
      planForDay,
      req.universePlan ?? null,
      req.rank ?? null,
    );
    const codes = res.matches.map((m) => m.code);
    await this.cache.setScreen(planBaseKey, asof, codes, currentTradeDay);
    return codes;
  }

  // ---- internals ----

  private async runEvaluate(
    signals: readonly BacktestSignal[],
    holdings: readonly number[],
    traceId: string,
    currentTradeDay: Date,
  ): Promise<BacktestEvaluateResponse> {
    const codes = uniqueCodes(signals);
    const { kStart, kEnd } = klineWindow(signals, holdings);
    const rowsByCode = await this.klineReader.bulkRangeForScreen(codes, kStart, kEnd);

    const klinesArg: Record<string, { trade_date: string[]; open_qfq: number[] }> = {};
    for (const code of codes) {
      const bars = rowsByCode[code];
      if (bars === undefined || bars.length === 0) continue;
      const trade_date: string[] = [];
      const open_qfq: number[] = [];
      for (const b of bars) {
        trade_date.push(b.trade_date);
        open_qfq.push(b.open_qfq);
      }
      klinesArg[code] = { trade_date, open_qfq };
    }

    const baselines = await this.universeBaselines(signals, holdings, currentTradeDay);
    await this.cache.flush();

    const args: Record<string, unknown> = {
      signals: signals.map((s) => ({ signal_date: s.signalDate, code: s.code })),
      klines: klinesArg,
      holdings: [...holdings],
      baselines,
    };
    const result = await this.flight.doGet('evaluate_signal', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new Error('evaluate_signal returned no payload');
    }
    return BacktestEvaluateResponseSchema.parse(payload);
  }

  /**
   * Compute the universe baseline per (holding, entry_day). For each
   * trading day E in [minSignal+1, maxSignal+1+maxHolding], we want
   * `mean(open(E+h)/open(E) - 1)` over every code in the universe.
   *
   * Implementation: single DuckDB query per holding, joining each bar
   * to the bar `h` trading-positions later within the same code. Bars
   * are dense (one per trading day per code), so `ROW_NUMBER` over
   * `(code, ts)` gives an integer "trading position" we can offset.
   *
   * Returns the shape Python expects:
   * `{ "<holding>": { "<entry_date YYYY-MM-DD>": [mean, std] } }`.
   *
   * Overridable: tests substitute this method on the instance to skip
   * the real DuckDB call (the unit suite stays purely in-memory).
   */
  protected async universeBaselines(
    signals: readonly BacktestSignal[],
    holdings: readonly number[],
    currentTradeDay: Date,
  ): Promise<Record<string, Record<string, [number, number]>>> {
    const window = klineWindow(signals, holdings);
    const start = isoFromDate(window.kStart);
    const end = isoFromDate(window.kEnd);
    const conn = await this.connection();

    const out: Record<string, Record<string, [number, number]>> = {};
    for (const h of new Set(holdings)) {
      const series = await this.universeBaselineForHolding(conn, h, start, end, currentTradeDay);
      out[String(h)] = series;
    }
    return out;
  }

  private async universeBaselineForHolding(
    conn: DuckDBConnection,
    holding: number,
    startIso: string,
    endIso: string,
    currentTradeDay: Date,
  ): Promise<Record<string, [number, number]>> {
    const fromCache: Record<string, [number, number]> = {};
    let needAny = false;
    const startMs = isoDateToMs(startIso);
    const endMs = isoDateToMs(endIso);
    // Walk every weekday in [start, end]; classify cached vs missing
    // using the persistent store + same-day freshness check.
    for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
      const dow = new Date(ms).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const day = msToIsoDate(ms);
      const cached = await this.cache.getBaseline(holding, day, currentTradeDay);
      if (cached !== null) {
        fromCache[day] = cached;
      } else {
        needAny = true;
      }
    }
    if (!needAny) return fromCache;

    // Recompute the whole window in one query (cheaper than per-day SQL).
    // Persist only the freshly computed days; rows already present and
    // fresh remain unchanged on disk.
    const fresh = await this.queryUniverseBaseline(conn, holding, startIso, endIso);
    const toPersist: { entryDay: string; mean: number; std: number }[] = [];
    for (const [day, pair] of Object.entries(fresh)) {
      if (fromCache[day] === undefined) {
        toPersist.push({ entryDay: day, mean: pair[0], std: pair[1] });
      }
      fromCache[day] = pair;
    }
    await this.cache.setBaselineMany(holding, toPersist, currentTradeDay);
    return fromCache;
  }

  private async queryUniverseBaseline(
    conn: DuckDBConnection,
    holding: number,
    startIso: string,
    endIso: string,
  ): Promise<Record<string, [number, number]>> {
    // DuckDB pushdown over the whole parquet glob; trade_date is the
    // primary partition column so the date range filter is cheap.
    const sql = `
      WITH bars AS (
        SELECT code, ts, open_qfq,
               ROW_NUMBER() OVER (PARTITION BY code ORDER BY ts) AS rn
        FROM read_parquet('${this.klineParquetGlob}')
        WHERE ts BETWEEN DATE '${startIso}' AND DATE '${endIso}'
          AND open_qfq IS NOT NULL AND open_qfq > 0
      )
      SELECT strftime(e.ts, '%Y-%m-%d') AS entry_date,
             AVG(x.open_qfq / e.open_qfq - 1) AS mean_ret,
             COALESCE(STDDEV_POP(x.open_qfq / e.open_qfq - 1), 0) AS std_ret
      FROM bars e
      JOIN bars x ON x.code = e.code AND x.rn = e.rn + ${String(holding)}
      GROUP BY e.ts
      ORDER BY e.ts
    `;
    const result = await conn.runAndReadAll(sql);
    const out: Record<string, [number, number]> = {};
    for (const row of result.getRowObjects()) {
      const entryDate = String(row['entry_date'] ?? '');
      const meanRet = Number(row['mean_ret'] ?? 0);
      const stdRet = Number(row['std_ret'] ?? 0);
      if (entryDate.length === 0) continue;
      out[entryDate] = [meanRet, stdRet];
    }
    return out;
  }

}

// -- helpers ----------------------------------------------------------------

function uniqueCodes(signals: readonly BacktestSignal[]): string[] {
  const seen = new Set<string>();
  for (const s of signals) seen.add(s.code);
  return [...seen].sort();
}

function klineWindow(
  signals: readonly BacktestSignal[],
  holdings: readonly number[],
): { kStart: Date; kEnd: Date } {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const s of signals) {
    const ms = isoDateToMs(s.signalDate);
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  const maxHolding = holdings.reduce((acc, h) => Math.max(acc, h), 0);
  const fwdCalendarDays =
    Math.ceil(maxHolding * HOLDING_TO_CALENDAR_MULTIPLIER) + CALENDAR_BUFFER_DAYS;
  return {
    kStart: new Date(minMs),
    kEnd: new Date(maxMs + fwdCalendarDays * 86_400_000),
  };
}

function isoDateToMs(s: string): number {
  // Treat as UTC midnight to match the kline store's `ts` semantics.
  const parts = s.split('-');
  const y = Number.parseInt(parts[0] ?? '0', 10);
  const m = Number.parseInt(parts[1] ?? '0', 10);
  const d = Number.parseInt(parts[2] ?? '0', 10);
  return Date.UTC(y, m - 1, d);
}

function msToIsoDate(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear().toString().padStart(4, '0');
  const m = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = dt.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isoFromDate(dt: Date): string {
  return msToIsoDate(dt.getTime());
}

function countMatchedDays(signals: readonly BacktestSignal[]): number {
  const days = new Set<string>();
  for (const s of signals) days.add(s.signalDate);
  return days.size;
}

function countWeekdays(startMs: number, endMs: number): number {
  let n = 0;
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

function extractFirstPayload(table: Table): unknown {
  if (table.numRows === 0) return null;
  const proxy = table.get(0);
  if (proxy === null) return null;
  const row: { payload_json?: unknown } = proxy.toJSON();
  const json = row.payload_json;
  if (typeof json !== 'string' || json.length === 0) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function emptyResponse(holdings: readonly number[]): BacktestEvaluateResponse {
  const sorted = [...new Set(holdings)].sort((a, b) => a - b);
  return {
    holdings: sorted,
    signalDateRange: null,
    universeSizeAvg: 0,
    observations: [],
    summary: sorted.map((h) => ({
      holding: h,
      n: 0,
      mean: 0,
      median: 0,
      std: 0,
      p05: 0,
      p25: 0,
      p75: 0,
      p95: 0,
      winRate: 0,
      sharpeLike: 0,
    })),
    baselineSummary: null,
    spreadSummary: null,
  };
}
