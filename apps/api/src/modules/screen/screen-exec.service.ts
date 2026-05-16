/**
 * In-process screening executor. Direct replacement for the Python
 * `screen_run` Flight op + `ScreenService.execute` orchestration.
 *
 * Pipeline (mirrors `services/py/quant_core/services/screen_service.py`):
 *   1. Resolve the universe — either filter the meta cache through
 *      {@link UniverseFilterService} or use the full code list.
 *   2. Walk the AST ({@link summarise}) to figure out columns +
 *      lookback bars; widen by 1.6× + 10-day calendar buffer to be
 *      safe across non-trading days.
 *   3. Fetch the per-code kline slice via
 *      {@link KlineReaderService.bulkRangeForScreen} (DuckDB-backed,
 *      pct_chg_qfq synthesised).
 *   4. Evaluate the predicate per code via {@link evaluatePredicate}.
 *   5. Collect evidence + rank metric per match.
 *   6. Apply rank (sort + topN) when provided.
 *
 * No Flight involvement; the call lives entirely in NestJS.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  QuantError,
  type RankSpecView,
  type ScreenPlanAst,
  type ScreenRunResult,
  type UniversePlanAst,
} from '@quant/shared';

import { KlineReaderService } from '../kline/kline-reader.service.js';
import { LocalStockMetaAdapter } from '../stock-meta/local-stock-meta.adapter.js';
import { planSignature } from './domain/pure/plan-signature.js';
import { buildEvidence, evidenceValue, type Evidence } from './domain/pure/screen-evidence.js';
import { evaluatePredicate, evaluateScalar, type ScreenRow } from './domain/pure/screen-eval.js';
import { summarise } from './domain/pure/screen-summarise.js';
import { UniverseFilterService } from './universe-filter.service.js';

/** 2024-09-20 — earliest stored kline bar (mirrors Py KLINE_FLOOR_DATE). */
const KLINE_FLOOR_DATE_MS = Date.UTC(2024, 8, 20);

const BUFFER_DAYS = 10;

@Injectable()
export class ScreenExecService {
  constructor(
    @Inject(KlineReaderService) private readonly klineReader: KlineReaderService,
    @Inject(LocalStockMetaAdapter) private readonly metaAdapter: LocalStockMetaAdapter,
    @Inject(UniverseFilterService) private readonly universeFilter: UniverseFilterService,
  ) {}

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
    const rankLookback = rankLookbackBars(rank);
    const lookback = Math.max(lookbackDays, rankLookback, 1);
    const calendarDays = Math.floor(lookback * 1.6) + BUFFER_DAYS;
    const startMs = Math.max(asof.getTime() - calendarDays * 86_400_000, KLINE_FLOOR_DATE_MS);
    const start = new Date(startMs);
    const rowsByCode = await this.klineReader.bulkRangeForScreen(universe, start, asof);
    const matchesRaw: Array<{ code: string; evidence: Evidence }> = [];
    for (const code of universe) {
      const stockRows = rowsByCode[code] ?? [];
      if (stockRows.length === 0) continue;
      if (!evaluatePredicate(stockRows, plan.expr)) continue;
      const evidence = buildEvidence(stockRows, plan.expr);
      const rankAttached: Evidence =
        rank === null
          ? evidence
          : {
              ...evidence,
              rank_metric: evidenceValue(evaluateScalar(stockRows, rank.metric)),
            };
      matchesRaw.push({ code, evidence: rankAttached });
    }
    const ordered = rank === null ? matchesRaw : applyRank(matchesRaw, rank);
    return {
      matches: ordered.map((m) => ({ code: m.code, evidence: m.evidence as unknown as Record<string, unknown> })),
      planSignature: signature,
    };
  }

  private async resolveUniverse(plan: UniversePlanAst | null): Promise<string[]> {
    if (plan === null) {
      const metas = await this.metaAdapter.listAll();
      return metas.map((m) => m.code);
    }
    return this.universeFilter.filterCodes(plan);
  }
}

function parseAsof(iso: string): Date {
  const y = Number.parseInt(iso.slice(0, 4), 10);
  const m = Number.parseInt(iso.slice(5, 7), 10);
  const d = Number.parseInt(iso.slice(8, 10), 10);
  const ms = Date.UTC(y, m - 1, d);
  if (ms < KLINE_FLOOR_DATE_MS) {
    throw new QuantError(
      'DSL_INVALID',
      `asof ${iso} precedes KLINE_FLOOR_DATE 2024-09-20`,
      { asof: iso },
    );
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
  matches: ReadonlyArray<{ code: string; evidence: Evidence }>,
  rank: RankSpecView,
): Array<{ code: string; evidence: Evidence }> {
  const keyed: Array<{ key: number; entry: { code: string; evidence: Evidence } }> = [];
  for (const m of matches) {
    const raw = m.evidence.rank_metric;
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

/** Used by ScreenRow consumers that need to materialise rows manually (tests). */
export type { ScreenRow };
