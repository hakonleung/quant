/**
 * Pure evaluator for the universe-screen DSL. Port of
 * `services/py/quant_core/domain/rules/universe_eval.py`.
 *
 * Operates on the canonical {@link StockMetaDto} shape, plus an optional
 * `snapshotByCode` map that unlocks the snapshot-derived fields
 * (`mkt_cap`, `pe_ttm`, `ret_*`, `dde_*` …). Callers that don't pass a
 * snapshot map get the legacy meta-only behaviour: any comparison
 * against a snapshot field resolves to `null` left-hand-side and
 * therefore evaluates to `false`, excluding the row.
 */

import {
  QuantError,
  type StockMetaDto,
  type StockSnapshotDto,
  type UniverseExpr,
  type UniversePlanAst,
} from '@quant/shared';

import { D } from '../../../../common/decimal.js';
import { UNIVERSE_SNAPSHOT_FIELD_SET } from './screen-fields.js';

const ST_PREFIXES = ['ST', '*ST', 'S*ST', 'SST'] as const;

/**
 * Map from code → snapshot. The evaluator only reads from it; we type
 * the input as a plain `Map` (not `ReadonlyMap`) for ergonomic callers
 * but never mutate.
 */
export type SnapshotByCode = ReadonlyMap<string, StockSnapshotDto>;

export function evaluateUniverse(
  plan: UniversePlanAst,
  metas: readonly StockMetaDto[],
  snapshotByCode?: SnapshotByCode,
): StockMetaDto[] {
  const asof = parseIsoDate(plan.asof);
  const snaps = snapshotByCode ?? EMPTY_SNAPSHOT_MAP;
  return metas.filter((m) => evalExpr(plan.expr, m, asof, snaps.get(m.code) ?? null));
}

const EMPTY_SNAPSHOT_MAP: SnapshotByCode = new Map<string, StockSnapshotDto>();

function evalExpr(
  expr: UniverseExpr,
  meta: StockMetaDto,
  asof: Date,
  snap: StockSnapshotDto | null,
): boolean {
  if (expr.kind === 'logical') {
    if (expr.op === 'not') {
      const first = expr.args[0];
      if (first === undefined) {
        throw new QuantError('EVALUATION_FAILED', "universe 'not' requires an arg", {});
      }
      return !evalExpr(first, meta, asof, snap);
    }
    if (expr.op === 'and') {
      for (const a of expr.args) if (!evalExpr(a, meta, asof, snap)) return false;
      return true;
    }
    for (const a of expr.args) if (evalExpr(a, meta, asof, snap)) return true;
    return false;
  }
  // expr.kind === 'compare'
  return evalCompare(expr, meta, asof, snap);
}

function evalCompare(
  node: Extract<UniverseExpr, { kind: 'compare' }>,
  meta: StockMetaDto,
  asof: Date,
  snap: StockSnapshotDto | null,
): boolean {
  const left = resolveField(node.left.field, meta, asof, snap);
  const right = node.right.value;
  const op = node.op;
  // Missing snapshot fields surface as null/undefined. Any comparison
  // against a null LHS evaluates false — semantically "exclude this row"
  // rather than "throw" — which matches the storage-layer convention
  // that null = "no data" everywhere else in the pipeline.
  if (left === null || left === undefined) return false;
  if (op === 'contains') {
    return typeof left === 'string' && typeof right === 'string' && left.includes(right);
  }
  if (op === 'starts_with') {
    return typeof left === 'string' && typeof right === 'string' && left.startsWith(right);
  }
  if (op === 'not_starts_with') {
    return typeof left === 'string' && typeof right === 'string' && !left.startsWith(right);
  }
  if (op === 'eq') return scalarEq(left, right);
  if (op === 'neq') return !scalarEq(left, right);
  if (op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte') {
    return orderedCompare(op, left, right);
  }
  throw new QuantError('EVALUATION_FAILED', `unhandled universe compare op: ${op}`, {});
}

function scalarEq(a: unknown, b: unknown): boolean {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string') {
    return a.getTime() === parseIsoDate(b).getTime();
  }
  if (typeof a === 'string' && b instanceof Date) {
    return parseIsoDate(a).getTime() === b.getTime();
  }
  // Numeric — coerce to Decimal for safety.
  try {
    return new D(a as string | number).eq(new D(b as string | number));
  } catch {
    return false;
  }
}

function orderedCompare(op: 'gt' | 'lt' | 'gte' | 'lte', left: unknown, right: unknown): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    throw new QuantError('EVALUATION_FAILED', 'ordered compare not supported on bool', {});
  }
  // Dates compare lexically as ISO strings already, or via getTime.
  if (
    left instanceof Date ||
    right instanceof Date ||
    isIsoDateString(left) ||
    isIsoDateString(right)
  ) {
    const l = coerceDate(left);
    const r = coerceDate(right);
    if (l === null || r === null) return false;
    switch (op) {
      case 'gt':
        return l.getTime() > r.getTime();
      case 'lt':
        return l.getTime() < r.getTime();
      case 'gte':
        return l.getTime() >= r.getTime();
      case 'lte':
        return l.getTime() <= r.getTime();
    }
  }
  try {
    const a = new D(left as string | number);
    const b = new D(right as string | number);
    switch (op) {
      case 'gt':
        return a.gt(b);
      case 'lt':
        return a.lt(b);
      case 'gte':
        return a.gte(b);
      case 'lte':
        return a.lte(b);
    }
  } catch {
    throw new QuantError(
      'EVALUATION_FAILED',
      `values not orderable: ${typeof left} vs ${typeof right}`,
      {},
    );
  }
}

function resolveField(
  name: string,
  meta: StockMetaDto,
  asof: Date,
  snap: StockSnapshotDto | null,
): unknown {
  switch (name) {
    case 'code':
      return meta.code;
    case 'name':
      return meta.name;
    case 'industries':
      return meta.industries;
    case 'list_date':
      return parseIsoDate(meta.list_date);
    case 'float_pct':
      return meta.float_pct; // decimal-string; orderedCompare/scalarEq parse it
    case 'is_st':
      return isSt(meta.name);
    case 'exchange':
      return exchangeForCode(meta.code);
    case 'listed_days':
      return Math.floor((asof.getTime() - parseIsoDate(meta.list_date).getTime()) / 86_400_000);
    default:
      if (UNIVERSE_SNAPSHOT_FIELD_SET.has(name)) {
        return resolveSnapshotField(name, snap);
      }
      throw new QuantError('EVALUATION_FAILED', `unhandled universe field: ${name}`, {});
  }
}

/**
 * Snapshot-side field accessor. Returns the decimal-string value (the
 * `orderedCompare`/`scalarEq` helpers parse it via `Decimal`), or
 * `null` when the row's snapshot block is missing or the specific
 * field hasn't been populated yet.
 */
function resolveSnapshotField(name: string, snap: StockSnapshotDto | null): string | null {
  if (snap === null) return null;
  switch (name) {
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

function isSt(name: string): boolean {
  const upper = name.trim().toUpperCase();
  return ST_PREFIXES.some((p) => upper.startsWith(p));
}

function exchangeForCode(code: string): string {
  if (!/^\d{6}$/.test(code)) return 'unknown';
  if (code.startsWith('920')) return 'bj';
  if (code.startsWith('60') || code.startsWith('68') || code.startsWith('900')) return 'sh';
  if (code.startsWith('00') || code.startsWith('30') || code.startsWith('20')) return 'sz';
  if (code.startsWith('4') || code.startsWith('8')) return 'bj';
  return 'unknown';
}

function parseIsoDate(iso: string): Date {
  // YYYY-MM-DD → UTC midnight.
  const y = Number.parseInt(iso.slice(0, 4), 10);
  const m = Number.parseInt(iso.slice(5, 7), 10);
  const d = Number.parseInt(iso.slice(8, 10), 10);
  return new Date(Date.UTC(y, m - 1, d));
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (isIsoDateString(value)) return parseIsoDate(value);
  return null;
}
