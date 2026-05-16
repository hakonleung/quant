/**
 * In-process screening executor. Direct replacement for the Python
 * `screen_run` Flight op + `ScreenService.execute` orchestration.
 *
 * Two execution paths:
 *
 *   1. **SQL pushdown** (fast): when `canPushdown(plan.expr)` returns
 *      true, compile the AST to a DuckDB SELECT and let the
 *      vectorised engine produce the matched code set. We then fetch
 *      kline for only those codes and run the interpreter on that
 *      narrow set to build per-match evidence + rank metric. SQL
 *      gives us the "filter 5500 codes fast"; the interpreter gives
 *      us the "produce the exact same evidence dict the FE expects".
 *   2. **Interpreter** (fallback): full universe → kline slice →
 *      per-code interpreter eval. Used for AST shapes the codegen
 *      can't handle (window assertions with nested aggregates, etc).
 *
 * Both paths share `evaluateMatches`, so evidence shape and rank
 * behaviour stay identical.
 *
 * NULL semantics + Decimal-vs-DOUBLE parity: see
 * `docs/perf/screen-pushdown.md`. Parity tests in
 * `test/modules/screen/screen-parity.spec.ts` lock the two paths to
 * the same matches on a representative plan set.
 */

import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  QuantError,
  type RankSpecView,
  type ScreenPlanAst,
  type ScreenRunResult,
  type UniversePlanAst,
} from '@quant/shared';

import { KlineReaderService } from '../kline/kline-reader.service.js';
import { KLINE_DATA_DIR } from '../kline/kline.token.js';
import { LocalStockMetaAdapter } from '../stock-meta/local-stock-meta.adapter.js';
import { planSignature } from './domain/pure/plan-signature.js';
import { buildEvidence, evidenceValue, type Evidence } from './domain/pure/screen-evidence.js';
import { evaluatePredicate, evaluateScalar, type ScreenRow } from './domain/pure/screen-eval.js';
import { canPushdown } from './domain/pure/screen-pushdown-check.js';
import { compilePushdownSql } from './domain/pure/screen-sql-codegen.js';
import { summarise } from './domain/pure/screen-summarise.js';
import { UniverseFilterService } from './universe-filter.service.js';

/** 2024-09-20 — earliest stored kline bar (mirrors Py KLINE_FLOOR_DATE). */
const KLINE_FLOOR_DATE_MS = Date.UTC(2024, 8, 20);

const BUFFER_DAYS = 10;

@Injectable()
export class ScreenExecService {
  private readonly logger = new Logger(ScreenExecService.name);
  private connPromise: Promise<DuckDBConnection> | null = null;
  private readonly klineParquetGlob: string;

  constructor(
    @Inject(KlineReaderService) private readonly klineReader: KlineReaderService,
    @Inject(LocalStockMetaAdapter) private readonly metaAdapter: LocalStockMetaAdapter,
    @Inject(UniverseFilterService) private readonly universeFilter: UniverseFilterService,
    @Inject(KLINE_DATA_DIR) klineDataRoot: string,
  ) {
    this.klineParquetGlob = join(klineDataRoot, 'kline', '*.parquet');
  }

  async execute(
    plan: ScreenPlanAst,
    universePlan: UniversePlanAst | null,
    rank: RankSpecView | null,
  ): Promise<ScreenRunResult> {
    const asof = parseAsof(plan.asof);
    const signature = planSignature(plan, rank);
    const universe = await this.resolveUniverse(universePlan);
    if (universe.length === 0) {
      return { matches: [], planSignature: signature };
    }
    const { lookbackDays } = summarise(plan.expr);
    const lookback = Math.max(lookbackDays, rankLookbackBars(rank), 1);
    const calendarDays = Math.floor(lookback * 1.6) + BUFFER_DAYS;
    const startMs = Math.max(asof.getTime() - calendarDays * 86_400_000, KLINE_FLOOR_DATE_MS);
    const start = new Date(startMs);

    if (canPushdown(plan.expr)) {
      try {
        return await this.executePushdown(plan, asof, start, universe, rank, signature);
      } catch (err) {
        // A codegen / execution failure shouldn't break user-facing screen
        // results. Log the cause and fall through to the interpreter.
        this.logger.warn(
          `screen_pushdown_failed signature=${signature} err=${err instanceof Error ? err.message : String(err)} — falling back to interpreter`,
        );
      }
    }
    return this.executeInterpreter(plan, asof, start, universe, rank, signature);
  }

  // -----------------------------------------------------------------------
  // pushdown path
  // -----------------------------------------------------------------------

  private async executePushdown(
    plan: ScreenPlanAst,
    asof: Date,
    start: Date,
    universe: readonly string[],
    rank: RankSpecView | null,
    signature: string,
  ): Promise<ScreenRunResult> {
    const matchedCodes = await this.runPushdownSql(plan, asof, start, universe);
    if (matchedCodes.length === 0) {
      return { matches: [], planSignature: signature };
    }
    const rowsByCode = await this.klineReader.bulkRangeForScreen(matchedCodes, start, asof);
    const matches = this.evaluateMatches(plan, matchedCodes, rowsByCode, rank, {
      // Trust SQL but enforce the interpreter as a parity guard; any
      // disagreement is logged + dropped (see evaluateMatches).
      enforcePredicate: true,
    });
    const ordered = rank === null ? matches : applyRank(matches, rank);
    return {
      matches: ordered.map((m) => ({ code: m.code, evidence: evidenceToWire(m.evidence) })),
      planSignature: signature,
    };
  }

  private async runPushdownSql(
    plan: ScreenPlanAst,
    asof: Date,
    start: Date,
    universe: readonly string[],
  ): Promise<string[]> {
    const { sql } = compilePushdownSql({
      asof: isoDate(asof),
      start: isoDate(start),
      universe,
      predicate: plan.expr,
      klineParquetGlob: this.klineParquetGlob,
    });
    const conn = await this.connection();
    const result = await conn.runAndReadAll(sql);
    const matchedCodes: string[] = [];
    for (const row of result.getRowObjects()) {
      const code = readCodeField(row);
      if (code !== null) matchedCodes.push(code);
    }
    return matchedCodes;
  }

  // -----------------------------------------------------------------------
  // interpreter path (fallback + the path for non-pushdownable plans)
  // -----------------------------------------------------------------------

  private async executeInterpreter(
    plan: ScreenPlanAst,
    asof: Date,
    start: Date,
    universe: readonly string[],
    rank: RankSpecView | null,
    signature: string,
  ): Promise<ScreenRunResult> {
    const rowsByCode = await this.klineReader.bulkRangeForScreen(universe, start, asof);
    const matches = this.evaluateMatches(plan, universe, rowsByCode, rank, {
      enforcePredicate: false,
    });
    const ordered = rank === null ? matches : applyRank(matches, rank);
    return {
      matches: ordered.map((m) => ({
        code: m.code,
        evidence: evidenceToWire(m.evidence),
      })),
      planSignature: signature,
    };
  }

  private evaluateMatches(
    plan: ScreenPlanAst,
    codes: readonly string[],
    rowsByCode: Record<string, readonly ScreenRow[]>,
    rank: RankSpecView | null,
    opts: { enforcePredicate: boolean },
  ): { code: string; evidence: Evidence }[] {
    const out: { code: string; evidence: Evidence }[] = [];
    for (const code of codes) {
      const stockRows = rowsByCode[code] ?? [];
      if (stockRows.length === 0) continue;
      // `enforcePredicate=false` is the legacy interpreter path: we
      // evaluate the predicate to decide membership. `=true` is the
      // pushdown path: SQL already filtered, but we still run the
      // predicate to catch silent disagreement.
      if (!evaluatePredicate(stockRows, plan.expr)) {
        if (opts.enforcePredicate) {
          this.logger.warn(
            `screen_pushdown_disagreement code=${code} — SQL matched but interpreter rejected; dropping`,
          );
        }
        continue;
      }
      const evidence = buildEvidence(stockRows, plan.expr);
      const rankAttached: Evidence =
        rank === null
          ? evidence
          : {
              ...evidence,
              rank_metric: evidenceValue(evaluateScalar(stockRows, rank.metric)),
            };
      out.push({ code, evidence: rankAttached });
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // helpers
  // -----------------------------------------------------------------------

  private async resolveUniverse(plan: UniversePlanAst | null): Promise<string[]> {
    if (plan === null) {
      const metas = await this.metaAdapter.listAll();
      return metas.map((m) => m.code);
    }
    return this.universeFilter.filterCodes(plan);
  }

  private connection(): Promise<DuckDBConnection> {
    this.connPromise ??= (async () => {
      const inst = await DuckDBInstance.create(':memory:');
      return inst.connect();
    })();
    return this.connPromise;
  }
}

/**
 * Read the `code` field from a DuckDB row without an explicit type
 * assertion. Returns null when the row shape is unexpected so callers
 * can skip rather than throw.
 */
function readCodeField(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  if (!Object.prototype.hasOwnProperty.call(row, 'code')) return null;
  const code = Reflect.get(row, 'code');
  return typeof code === 'string' ? code : null;
}

/**
 * Project an Evidence dict (typed) into the wire-format Record. Keeps
 * the public schema honest without crossing the codebase's no-type-
 * assertion rule.
 */
function evidenceToWire(ev: Evidence): Record<string, unknown> {
  const out: Record<string, unknown> = {
    window: ev.window,
    metrics: ev.metrics,
  };
  if (ev['rank_metric'] !== undefined) out['rank_metric'] = ev['rank_metric'];
  return out;
}

function parseAsof(iso: string): Date {
  const y = Number.parseInt(iso.slice(0, 4), 10);
  const m = Number.parseInt(iso.slice(5, 7), 10);
  const d = Number.parseInt(iso.slice(8, 10), 10);
  const ms = Date.UTC(y, m - 1, d);
  if (ms < KLINE_FLOOR_DATE_MS) {
    throw new QuantError('DSL_INVALID', `asof ${iso} precedes KLINE_FLOOR_DATE 2024-09-20`, {
      asof: iso,
    });
  }
  return new Date(ms);
}

function rankLookbackBars(rank: RankSpecView | null): number {
  if (rank === null) return 1;
  return scalarLookback(rank.metric);
}

function scalarLookback(scalar: RankSpecView['metric']): number {
  switch (scalar.kind) {
    case 'field':
    case 'const':
      return 1;
    case 'agg':
      return scalar.window.days;
    case 'period_return':
      return scalar.window.days + 1;
    case 'scale':
      return scalarLookback(scalar.inner);
  }
}

function applyRank(
  matches: readonly { code: string; evidence: Evidence }[],
  rank: RankSpecView,
): { code: string; evidence: Evidence }[] {
  const keyed: { key: number; entry: { code: string; evidence: Evidence } }[] = [];
  for (const m of matches) {
    const raw = m.evidence['rank_metric'];
    if (raw === null || raw === undefined) continue;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) continue;
    keyed.push({ key: parsed, entry: m });
  }
  keyed.sort((a, b) => (rank.order === 'desc' ? b.key - a.key : a.key - b.key));
  const out = keyed.map((k) => k.entry);
  if (rank.topN !== null && rank.topN >= 0) {
    return out.slice(0, rank.topN);
  }
  return out;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Used by ScreenRow consumers that need to materialise rows manually (tests). */
export type { ScreenRow };
