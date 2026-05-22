/**
 * Single-source row assembler for stock-list surfaces.
 *
 * Replaces the FE-side stitch of `useStockMeta` + `useKlineBulk` +
 * `useStockSnapshots` with one BE call: caller passes `{ kind, codes,
 * columns?, sort? }`, gets fully-populated `StockListRow[]` already
 * sorted by the canonical default (or the explicit `sort` override).
 *
 * Three IM instruction handlers (sector.show, watch, screen) and the
 * FE list pane both compose this — guarantees identical column order
 * and sort across every render path.
 *
 * Snapshot fields (mktCap / PE / PB / PEG / margin / multi-day returns)
 * come from `StockMetaService.listSnapshots`; turnover / turnoverRate /
 * consecUp come from the latest kline bars via `KlineReaderService`.
 * The kline fetch is skipped when no applied column needs it.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_APPLIED_STOCK_LIST_COLUMNS,
  DEFAULT_SORT_BY_KIND,
  appliedNeedsSnapshot,
  deriveStockStats,
  getStockListColumnSpec,
  type KlineBar,
  type StockListColumnKey,
  type StockListKind,
  type StockListRow,
  type StockListRowsResponse,
  type StockListSort,
  type StockMetaDto,
  type StockSnapshotDto,
} from '@quant/shared';

import { KlineReaderService } from '../kline/kline-reader.service.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';

const KLINE_TAIL_FOR_STATS = 30;

export interface AssembleRowsArgs {
  readonly kind: StockListKind;
  readonly codes: readonly string[];
  readonly columns?: readonly StockListColumnKey[];
  readonly sort?: StockListSort;
  readonly traceId: string;
  /**
   * Optional per-code evidence map — surfaced verbatim on every row's
   * `evidence` field. Caller pre-formats the values; this service
   * doesn't interpret them. Used by dynamic-sector handlers.
   */
  readonly evidenceByCode?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

@Injectable()
export class StockListService {
  constructor(
    @Inject(StockMetaService) private readonly meta: StockMetaService,
    @Inject(KlineReaderService) private readonly kline: KlineReaderService,
  ) {}

  async assembleRows(args: AssembleRowsArgs): Promise<StockListRowsResponse> {
    const columns =
      args.columns !== undefined && args.columns.length > 0
        ? args.columns
        : DEFAULT_APPLIED_STOCK_LIST_COLUMNS;
    const sort = args.sort ?? DEFAULT_SORT_BY_KIND[args.kind];

    const needSnapshot = appliedNeedsSnapshot(columns) || hasSnapshotOnlyField(columns);
    const needKline = hasKlineDerivedField(columns);

    const emptyKline: Record<string, readonly KlineBar[]> = {};
    const [snapshots, klineBulk] = await Promise.all([
      needSnapshot
        ? this.meta.listSnapshots(args.codes, args.traceId)
        : this.meta.getBatch(args.codes, args.traceId).then(metasToSnapshotShells),
      needKline
        ? this.kline.lastNBulk(args.codes, KLINE_TAIL_FOR_STATS)
        : Promise.resolve(emptyKline),
    ]);

    const snapshotByCode = new Map<string, StockSnapshotDto>();
    for (const s of snapshots) snapshotByCode.set(s.meta.code, s);

    // Empty `codes` means "full universe" — same convention the
    // underlying meta.listSnapshots / kline.lastNBulk already follow.
    // In that mode we enumerate from whichever side returned data
    // (snapshots first, then any kline-only codes), so the synthetic
    // FE All sector and the IM full-universe paths share one code path.
    const enumeratedCodes: readonly string[] =
      args.codes.length > 0
        ? args.codes
        : Array.from(new Set([...snapshotByCode.keys(), ...Object.keys(klineBulk)])).sort();

    const rows: StockListRow[] = enumeratedCodes.map((code) => {
      const snap = snapshotByCode.get(code);
      const bars = klineBulk[code] ?? [];
      const stats = bars.length > 0 ? deriveStockStats(bars) : null;
      const evidence = args.evidenceByCode?.[code];
      return buildRow(code, snap, stats, evidence);
    });

    rows.sort((a, b) => compareRows(a, b, sort));

    // `buildRow` constructs rows from already-typed inputs; revalidating
    // the entire ~5500-row array through zod on every request added noise
    // without catching internal contract drift (CLAUDE.md §1.3 — internal
    // pure functions trust the contract). The DTO schema still gates the
    // BFF boundary in `apps/web/app/api/stock-list/rows/route.ts`.
    return {
      kind: args.kind,
      columns: [...columns],
      sort,
      rows,
    };
  }
}

function buildRow(
  code: string,
  snap: StockSnapshotDto | undefined,
  stats: ReturnType<typeof deriveStockStats> | null,
  evidence: Readonly<Record<string, string>> | undefined,
): StockListRow {
  const meta = snap?.meta;
  const derived = snap?.derived;
  const returns = snap?.returns;
  const dde = snap?.dde;
  const row: StockListRow = {
    code,
    name: meta?.name ?? null,
    price: parseDecimalOr(snap?.price, stats?.price ?? null),
    chgPct: parseDecimalOr(returns?.ret_1d, stats?.chgPct ?? null),
    turnoverRate: stats?.turnoverRate ?? null,
    turnover: stats?.turnover ?? null,
    consecUp: stats?.consecUpDays ?? null,
    ret5d: parseDecimal(returns?.ret_5d),
    ret10d: parseDecimal(returns?.ret_10d),
    ret20d: parseDecimal(returns?.ret_20d),
    ret90d: parseDecimal(returns?.ret_90d),
    ret250d: parseDecimal(returns?.ret_250d),
    wcmi: parseDecimal(derived?.wcmi),
    wcmiRhythm: parseDecimal(derived?.wcmi_rhythm),
    wcmiMaSupport: parseDecimal(derived?.wcmi_ma_support),
    wcmiUpWave: parseDecimal(derived?.wcmi_up_wave),
    wcmiYangDom: parseDecimal(derived?.wcmi_yang_dom),
    wcmiShadowClean: parseDecimal(derived?.wcmi_shadow_clean),
    wcmiStageGain: parseDecimal(derived?.wcmi_stage_gain),
    wcmiCrashAvoid: parseDecimal(derived?.wcmi_crash_avoid),
    wcmiRecentStrength: parseDecimal(derived?.wcmi_recent_strength),
    mktCap: parseDecimal(derived?.mkt_cap),
    floatMktCap: parseDecimal(derived?.float_mkt_cap),
    peTtm: parseDecimal(derived?.pe_ttm),
    peDynamic: parseDecimal(derived?.pe_dynamic),
    pb: parseDecimal(derived?.pb),
    peg: parseDecimal(derived?.peg),
    grossMargin: parseDecimal(derived?.gross_margin_ttm),
    ddeMainInflow3d: parseDecimal(dde?.main_net_inflow_3d),
    ddeMainInflow5d: parseDecimal(dde?.main_net_inflow_5d),
    ddeMainInflow10d: parseDecimal(dde?.main_net_inflow_10d),
    ddeMainInflow20d: parseDecimal(dde?.main_net_inflow_20d),
    ddeMainInflowRatio3d: parseDecimal(dde?.main_inflow_ratio_3d),
    ddeMainInflowRatio5d: parseDecimal(dde?.main_inflow_ratio_5d),
    ddeMainInflowRatio10d: parseDecimal(dde?.main_inflow_ratio_10d),
    ddeMainInflowRatio20d: parseDecimal(dde?.main_inflow_ratio_20d),
    ...(evidence !== undefined ? { evidence: { ...evidence } } : {}),
  };
  return row;
}

function metasToSnapshotShells(metas: readonly StockMetaDto[]): readonly StockSnapshotDto[] {
  return metas.map((m) => ({
    meta: m,
    price: null,
    asof: null,
    derived: {
      mkt_cap: null,
      float_mkt_cap: null,
      pe_ttm: null,
      pe_dynamic: null,
      pb: null,
      peg: null,
      gross_margin_ttm: null,
      wcmi: null,
      wcmi_rhythm: null,
      wcmi_ma_support: null,
      wcmi_up_wave: null,
      wcmi_yang_dom: null,
      wcmi_shadow_clean: null,
      wcmi_stage_gain: null,
      wcmi_crash_avoid: null,
      wcmi_recent_strength: null,
    },
    returns: {
      ret_1d: null,
      ret_5d: null,
      ret_10d: null,
      ret_20d: null,
      ret_90d: null,
      ret_250d: null,
    },
    dde: null,
  }));
}

function parseDecimal(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseDecimalOr(raw: string | null | undefined, fallback: number | null): number | null {
  const parsed = parseDecimal(raw);
  return parsed ?? fallback;
}

const KLINE_DERIVED_KEYS: ReadonlySet<StockListColumnKey> = new Set<StockListColumnKey>([
  'turnoverRate',
  'turnover',
  'consecUp',
]);

function hasKlineDerivedField(columns: readonly StockListColumnKey[]): boolean {
  for (const c of columns) if (KLINE_DERIVED_KEYS.has(c)) return true;
  return false;
}

const SNAPSHOT_ONLY_KEYS: ReadonlySet<StockListColumnKey> = new Set<StockListColumnKey>([
  'price',
  'chgPct',
]);

function hasSnapshotOnlyField(columns: readonly StockListColumnKey[]): boolean {
  for (const c of columns) {
    const spec = getStockListColumnSpec(c);
    if (spec.source === 'snapshot') return true;
    if (SNAPSHOT_ONLY_KEYS.has(c)) return true;
  }
  return false;
}

function compareRows(a: StockListRow, b: StockListRow, sort: StockListSort): number {
  const av = pickSortValue(a, sort.key);
  const bv = pickSortValue(b, sort.key);
  // Nulls always sort to the bottom regardless of direction so `—`
  // rows cluster — apply the dir flip only to value-vs-value compares.
  if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
  if (bv === null || bv === undefined) return -1;
  const cmp = compareValues(av, bv);
  return sort.dir === 'asc' ? cmp : -cmp;
}

function pickSortValue(row: StockListRow, key: StockListColumnKey): number | string | null {
  switch (key) {
    case 'name':
      return row.name;
    case 'price':
      return row.price;
    case 'chgPct':
      return row.chgPct;
    case 'turnoverRate':
      return row.turnoverRate;
    case 'turnover':
      return row.turnover;
    case 'consecUp':
      return row.consecUp;
    case 'ret5d':
      return row.ret5d;
    case 'ret10d':
      return row.ret10d;
    case 'ret20d':
      return row.ret20d;
    case 'ret90d':
      return row.ret90d;
    case 'ret250d':
      return row.ret250d;
    case 'wcmi':
      return row.wcmi;
    case 'wcmiRhythm':
      return row.wcmiRhythm;
    case 'wcmiMaSupport':
      return row.wcmiMaSupport;
    case 'wcmiUpWave':
      return row.wcmiUpWave;
    case 'wcmiYangDom':
      return row.wcmiYangDom;
    case 'wcmiShadowClean':
      return row.wcmiShadowClean;
    case 'wcmiStageGain':
      return row.wcmiStageGain;
    case 'wcmiCrashAvoid':
      return row.wcmiCrashAvoid;
    case 'wcmiRecentStrength':
      return row.wcmiRecentStrength;
    case 'mktCap':
      return row.mktCap;
    case 'floatMktCap':
      return row.floatMktCap;
    case 'peTtm':
      return row.peTtm;
    case 'peDynamic':
      return row.peDynamic;
    case 'pb':
      return row.pb;
    case 'peg':
      return row.peg;
    case 'grossMargin':
      return row.grossMargin;
    case 'ddeMainInflow3d':
      return row.ddeMainInflow3d;
    case 'ddeMainInflow5d':
      return row.ddeMainInflow5d;
    case 'ddeMainInflow10d':
      return row.ddeMainInflow10d;
    case 'ddeMainInflow20d':
      return row.ddeMainInflow20d;
    case 'ddeMainInflowRatio3d':
      return row.ddeMainInflowRatio3d;
    case 'ddeMainInflowRatio5d':
      return row.ddeMainInflowRatio5d;
    case 'ddeMainInflowRatio10d':
      return row.ddeMainInflowRatio10d;
    case 'ddeMainInflowRatio20d':
      return row.ddeMainInflowRatio20d;
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// Used by tests to silence the unused-import lint for KlineBar in this file.
void (null as unknown as KlineBar);
