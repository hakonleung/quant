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

import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { ScreenExecService } from '../screen/screen-exec.service.js';
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

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @Inject(BACKTEST_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(KlineReaderService) private readonly klineReader: KlineReaderService,
    @Inject(ScreenExecService) private readonly screenExec: ScreenExecService,
  ) {}

  async evaluateSignals(
    req: BacktestEvaluateSignalsRequest,
    traceId: string,
  ): Promise<BacktestEvaluateResponse> {
    return this.runEvaluate(req.signals, req.holdings, traceId);
  }

  async evaluateScreen(
    req: BacktestEvaluateScreenRequest,
    traceId: string,
  ): Promise<BacktestEvaluateResponse> {
    const startMs = isoDateToMs(req.startDate);
    const endMs = isoDateToMs(req.endDate);
    if (startMs > endMs) {
      throw new Error(`startDate (${req.startDate}) must be <= endDate (${req.endDate})`);
    }

    const signals: BacktestSignal[] = [];
    let runDays = 0;
    let matchedDays = 0;
    for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
      const d = new Date(ms);
      // Skip Sat (6) / Sun (0) — non-trading days. A-share holidays
      // mid-week still get visited; on those the screen yields zero
      // matches because no bar exists for `asof`, which is what we want.
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      runDays += 1;
      const asof = msToIsoDate(ms);
      const planForDay: ScreenPlanAst = { ...req.screenPlan, asof };
      const res = await this.screenExec.execute(
        planForDay,
        req.universePlan ?? null,
        req.rank ?? null,
      );
      if (res.matches.length === 0) continue;
      matchedDays += 1;
      for (const m of res.matches) {
        signals.push({ signalDate: asof, code: m.code });
      }
    }
    this.logger.log(
      `evaluate_screen runDays=${String(runDays)} matchedDays=${String(matchedDays)} ` +
        `signals=${String(signals.length)} trace_id=${traceId}`,
    );

    if (signals.length === 0) {
      return emptyResponse(req.holdings);
    }
    return this.runEvaluate(signals, req.holdings, traceId);
  }

  // ---- internals ----

  private async runEvaluate(
    signals: readonly BacktestSignal[],
    holdings: readonly number[],
    traceId: string,
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

    const args: Record<string, unknown> = {
      signals: signals.map((s) => ({ signal_date: s.signalDate, code: s.code })),
      klines: klinesArg,
      holdings: [...holdings],
    };
    const result = await this.flight.doGet('evaluate_signal', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new Error('evaluate_signal returned no payload');
    }
    return BacktestEvaluateResponseSchema.parse(payload);
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
  };
}
