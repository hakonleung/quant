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
  type DslScalar,
  type RankSpecView,
  type ScreenPlanAst,
  type ScreenRunResult,
  type StockSnapshotDto,
  type UniversePlanAst,
} from '@quant/shared';

import { D, type Dec } from '../../common/decimal.js';
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

    // Rank metrics that reference universe_field (wcmi / pe_* / ret_* /
    // dde_* …) need a per-code snapshot map; load it once up-front.
    // Cheap relative to the kline read, so we accept the eager cost
    // rather than threading a lazy loader through both paths.
    const snapshotByCode = rank !== null && needsSnapshot(rank.metric)
      ? await this.loadSnapshotMap()
      : null;

    if (canPushdown(plan.expr)) {
      try {
        return await this.executePushdown(
          plan,
          asof,
          start,
          universe,
          rank,
          signature,
          snapshotByCode,
        );
      } catch (err) {
        // A codegen / execution failure shouldn't break user-facing screen
        // results. Log the cause and fall through to the interpreter.
        this.logger.warn(
          `screen_pushdown_failed signature=${signature} err=${err instanceof Error ? err.message : String(err)} — falling back to interpreter`,
        );
      }
    }
    return this.executeInterpreter(plan, asof, start, universe, rank, signature, snapshotByCode);
  }

  private async loadSnapshotMap(): Promise<ReadonlyMap<string, StockSnapshotDto>> {
    const snapshots = await this.metaAdapter.listSnapshots([]);
    const map = new Map<string, StockSnapshotDto>();
    for (const s of snapshots) map.set(s.meta.code, s);
    return map;
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
    snapshotByCode: ReadonlyMap<string, StockSnapshotDto> | null,
  ): Promise<ScreenRunResult> {
    const matchedCodes = await this.runPushdownSql(plan, asof, start, universe);
    if (matchedCodes.length === 0) {
      return { matches: [], planSignature: signature };
    }
    const rowsByCode = await this.klineReader.bulkRangeForScreen(matchedCodes, start, asof);
    const matches = this.evaluateMatches(plan, matchedCodes, rowsByCode, rank, snapshotByCode, {
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
    snapshotByCode: ReadonlyMap<string, StockSnapshotDto> | null,
  ): Promise<ScreenRunResult> {
    const rowsByCode = await this.klineReader.bulkRangeForScreen(universe, start, asof);
    const matches = this.evaluateMatches(plan, universe, rowsByCode, rank, snapshotByCode, {
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
    snapshotByCode: ReadonlyMap<string, StockSnapshotDto> | null,
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
              rank_metric: evidenceValue(
                evaluateRankMetric(stockRows, rank.metric, snapshotByCode?.get(code) ?? null),
              ),
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
    case 'universe_field':
      return 1;
    case 'agg':
      return scalar.window.days;
    case 'period_return':
      return scalar.window.days + 1;
    case 'scale':
      return scalarLookback(scalar.inner);
  }
}

function needsSnapshot(scalar: DslScalar): boolean {
  switch (scalar.kind) {
    case 'universe_field':
      return true;
    case 'scale':
      return needsSnapshot(scalar.inner);
    case 'field':
    case 'const':
    case 'agg':
    case 'period_return':
      return false;
  }
}

/**
 * Rank-step scalar evaluator. Same shape as `evaluateScalar` but resolves
 * `universe_field` from the per-code snapshot. Returns null when the
 * value is unavailable (kline interpreter NA / missing snapshot field) —
 * `applyRank` skips those rows so they don't poison the sort.
 */
function evaluateRankMetric(
  rows: readonly ScreenRow[],
  scalar: DslScalar,
  snap: StockSnapshotDto | null,
): Dec | null {
  switch (scalar.kind) {
    case 'universe_field': {
      const value = readSnapshotField(snap, scalar.field);
      if (value === null) return null;
      try {
        const dec = new D(value);
        return dec.isFinite() ? dec : null;
      } catch {
        return null;
      }
    }
    case 'scale': {
      const inner = evaluateRankMetric(rows, scalar.inner, snap);
      if (inner === null) return null;
      return inner.mul(new D(scalar.factor));
    }
    case 'field':
    case 'const':
    case 'agg':
    case 'period_return':
      return evaluateScalar(rows, scalar);
  }
}

function readSnapshotField(snap: StockSnapshotDto | null, field: string): string | null {
  if (snap === null) return null;
  switch (field) {
    case 'price':
      return snap.price;
    case 'mkt_cap':
      return snap.derived.mkt_cap;
    case 'float_mkt_cap':
      return snap.derived.float_mkt_cap;
    case 'pe_ttm':
      return snap.derived.pe_ttm;
    case 'pe_dynamic':
      return snap.derived.pe_dynamic;
    case 'pb':
      return snap.derived.pb;
    case 'peg':
      return snap.derived.peg;
    case 'gross_margin_ttm':
      return snap.derived.gross_margin_ttm;
    case 'wcmi':
      return snap.derived.wcmi;
    case 'wcmi_rhythm':
      return snap.derived.wcmi_rhythm;
    case 'wcmi_ma_support':
      return snap.derived.wcmi_ma_support;
    case 'wcmi_up_wave':
      return snap.derived.wcmi_up_wave;
    case 'wcmi_yang_dom':
      return snap.derived.wcmi_yang_dom;
    case 'wcmi_shadow_clean':
      return snap.derived.wcmi_shadow_clean;
    case 'wcmi_stage_gain':
      return snap.derived.wcmi_stage_gain;
    case 'wcmi_crash_avoid':
      return snap.derived.wcmi_crash_avoid;
    case 'wcmi_recent_strength':
      return snap.derived.wcmi_recent_strength;
    case 'ret_1d':
      return snap.returns.ret_1d;
    case 'ret_5d':
      return snap.returns.ret_5d;
    case 'ret_10d':
      return snap.returns.ret_10d;
    case 'ret_20d':
      return snap.returns.ret_20d;
    case 'ret_90d':
      return snap.returns.ret_90d;
    case 'ret_250d':
      return snap.returns.ret_250d;
    case 'dde_main_net_inflow_3d':
      return snap.dde?.main_net_inflow_3d ?? null;
    case 'dde_main_net_inflow_5d':
      return snap.dde?.main_net_inflow_5d ?? null;
    case 'dde_main_net_inflow_10d':
      return snap.dde?.main_net_inflow_10d ?? null;
    case 'dde_main_net_inflow_20d':
      return snap.dde?.main_net_inflow_20d ?? null;
    case 'dde_main_inflow_ratio_3d':
      return snap.dde?.main_inflow_ratio_3d ?? null;
    case 'dde_main_inflow_ratio_5d':
      return snap.dde?.main_inflow_ratio_5d ?? null;
    case 'dde_main_inflow_ratio_10d':
      return snap.dde?.main_inflow_ratio_10d ?? null;
    case 'dde_main_inflow_ratio_20d':
      return snap.dde?.main_inflow_ratio_20d ?? null;
    default:
      return null;
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
