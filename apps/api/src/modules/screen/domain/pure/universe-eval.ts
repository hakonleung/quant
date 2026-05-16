/**
 * Pure evaluator for the universe-screen DSL. Port of
 * `services/py/quant_core/domain/rules/universe_eval.py`.
 *
 * Operates on the canonical {@link StockMetaDto} shape. Derived fields
 * (`is_st`, `exchange`, `listed_days`) are computed inline so callers
 * don't have to pre-normalise the meta rows.
 */

import { QuantError, type StockMetaDto, type UniverseExpr, type UniversePlanAst } from '@quant/shared';

import { D } from '../../../../common/decimal.js';

const ST_PREFIXES = ['ST', '*ST', 'S*ST', 'SST'] as const;

export function evaluateUniverse(
  plan: UniversePlanAst,
  metas: readonly StockMetaDto[],
): StockMetaDto[] {
  const asof = parseIsoDate(plan.asof);
  return metas.filter((m) => evalExpr(plan.expr, m, asof));
}

function evalExpr(expr: UniverseExpr, meta: StockMetaDto, asof: Date): boolean {
  if (expr.kind === 'logical') {
    if (expr.op === 'not') {
      const first = expr.args[0];
      if (first === undefined) {
        throw new QuantError('EVALUATION_FAILED', "universe 'not' requires an arg", {});
      }
      return !evalExpr(first, meta, asof);
    }
    if (expr.op === 'and') {
      for (const a of expr.args) if (!evalExpr(a, meta, asof)) return false;
      return true;
    }
    for (const a of expr.args) if (evalExpr(a, meta, asof)) return true;
    return false;
  }
  // expr.kind === 'compare'
  return evalCompare(expr, meta, asof);
}

function evalCompare(
  node: Extract<UniverseExpr, { kind: 'compare' }>,
  meta: StockMetaDto,
  asof: Date,
): boolean {
  const left = resolveField(node.left.field, meta, asof);
  const right = node.right.value;
  const op = node.op;
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
  if (left instanceof Date || right instanceof Date || isIsoDateString(left) || isIsoDateString(right)) {
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

function resolveField(name: string, meta: StockMetaDto, asof: Date): unknown {
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
      throw new QuantError('EVALUATION_FAILED', `unhandled universe field: ${name}`, {});
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

