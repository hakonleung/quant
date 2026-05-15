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
  StockListRowSchema,
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

    const rows: StockListRow[] = args.codes.map((code) => {
      const snap = snapshotByCode.get(code);
      const bars = klineBulk[code] ?? [];
      const stats = bars.length > 0 ? deriveStockStats(bars) : null;
      const evidence = args.evidenceByCode?.[code];
      return buildRow(code, snap, stats, evidence);
    });

    rows.sort((a, b) => compareRows(a, b, sort));

    StockListRowSchema.array().parse(rows);
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
    mktCap: parseDecimal(derived?.mkt_cap),
    floatMktCap: parseDecimal(derived?.float_mkt_cap),
    peTtm: parseDecimal(derived?.pe_ttm),
    peDynamic: parseDecimal(derived?.pe_dynamic),
    pb: parseDecimal(derived?.pb),
    peg: parseDecimal(derived?.peg),
    grossMargin: parseDecimal(derived?.gross_margin_ttm),
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
    },
    returns: {
      ret_1d: null,
      ret_5d: null,
      ret_10d: null,
      ret_20d: null,
      ret_90d: null,
      ret_250d: null,
    },
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
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// Used by tests to silence the unused-import lint for KlineBar in this file.
void (null as unknown as KlineBar);
