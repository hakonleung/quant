/**
 * Pure interpreter for the screening predicate DSL.
 *
 * Port of `services/py/quant_core/domain/rules/screen_eval.py`. Operates
 * on a per-code `ScreenRow[]` slice sorted ascending by `trade_date`;
 * `rows[rows.length - 1]` is the `asof` bar.
 *
 * Null sentinel: a row's column being `null` (missing ma60 on a fresh
 * listing, missing `pct_chg_qfq` on the first bar of the slice) makes
 * every Compare that touches it evaluate to false — matches Python's
 * `_NA` semantics.
 */

import { QuantError, type DslPredicate, type DslScalar } from '@quant/shared';

import { D, type Dec } from '../../../../common/decimal.js';
import type { AggOp, CompareOp } from './screen-fields.js';

export interface ScreenRow {
  readonly trade_date: string; // ISO YYYY-MM-DD
  readonly open_qfq: number;
  readonly high_qfq: number;
  readonly low_qfq: number;
  readonly close_qfq: number;
  readonly volume: number;
  readonly amount: number;
  readonly turnover_rate: number;
  readonly ma5: number | null;
  readonly ma10: number | null;
  readonly ma20: number | null;
  readonly ma60: number | null;
  readonly pct_chg_qfq: number | null;
}

/** Sentinel — Py's `_NA`. */
const NA: unique symbol = Symbol('NA');
type Na = typeof NA;

/**
 * Evaluate a predicate against `rows`. Empty `rows` → false (matches Py).
 */
export function evaluatePredicate(rows: readonly ScreenRow[], pred: DslPredicate): boolean {
  if (rows.length === 0) return false;
  return evalPredicate(rows, pred);
}

/**
 * Evaluate a Scalar; returns `null` for the "no value" case so callers
 * (ranking, evidence) can detect it without importing the sentinel.
 */
export function evaluateScalar(rows: readonly ScreenRow[], scalar: DslScalar): Dec | null {
  if (rows.length === 0) return null;
  const v = evalScalar(rows, scalar);
  return v === NA ? null : v;
}

function evalPredicate(rows: readonly ScreenRow[], pred: DslPredicate): boolean {
  switch (pred.kind) {
    case 'compare':
      return evalCompare(rows, pred);
    case 'logical':
      return evalLogical(rows, pred);
    case 'for_all':
      return evalForAll(rows, pred);
    case 'exists':
      return evalExists(rows, pred);
    case 'consecutive':
      return evalConsecutive(rows, pred);
    default: {
      const exhaustive: never = pred;
      throw new QuantError(
        'EVALUATION_FAILED',
        `unhandled predicate kind: ${JSON.stringify(exhaustive)}`,
        {},
      );
    }
  }
}

function evalLogical(
  rows: readonly ScreenRow[],
  node: Extract<DslPredicate, { kind: 'logical' }>,
): boolean {
  if (node.op === 'not') {
    const first = node.args[0];
    if (first === undefined) {
      throw new QuantError('EVALUATION_FAILED', "logical 'not' requires an arg", {});
    }
    return !evalPredicate(rows, first);
  }
  if (node.op === 'and') {
    for (const a of node.args) {
      if (!evalPredicate(rows, a)) return false;
    }
    return true;
  }
  // 'or'
  for (const a of node.args) {
    if (evalPredicate(rows, a)) return true;
  }
  return false;
}

function evalCompare(
  rows: readonly ScreenRow[],
  node: Extract<DslPredicate, { kind: 'compare' }>,
): boolean {
  const left = evalScalar(rows, node.left);
  const right = evalScalar(rows, node.right);
  if (left === NA || right === NA) return false;
  if (!isCompareOp(node.op)) {
    throw new QuantError('EVALUATION_FAILED', `unhandled compare op: ${node.op}`, {});
  }
  switch (node.op) {
    case 'gt':
      return left.gt(right);
    case 'lt':
      return left.lt(right);
    case 'gte':
      return left.gte(right);
    case 'lte':
      return left.lte(right);
    case 'eq':
      return left.eq(right);
    case 'neq':
      return !left.eq(right);
  }
}

function evalForAll(
  rows: readonly ScreenRow[],
  node: Extract<DslPredicate, { kind: 'for_all' }>,
): boolean {
  const days = node.window.days;
  if (rows.length < days) return false;
  const window = rows.slice(rows.length - days);
  for (let i = 0; i < window.length; i++) {
    if (!evalPredicate(window.slice(0, i + 1), node.predicate)) return false;
  }
  return true;
}

function evalExists(
  rows: readonly ScreenRow[],
  node: Extract<DslPredicate, { kind: 'exists' }>,
): boolean {
  const days = node.window.days;
  if (rows.length < days) return false;
  const window = rows.slice(rows.length - days);
  for (let i = 0; i < window.length; i++) {
    if (evalPredicate(window.slice(0, i + 1), node.predicate)) return true;
  }
  return false;
}

function evalConsecutive(
  rows: readonly ScreenRow[],
  node: Extract<DslPredicate, { kind: 'consecutive' }>,
): boolean {
  let streak = 0;
  let longest = 0;
  for (let i = 0; i < rows.length; i++) {
    if (evalPredicate(rows.slice(0, i + 1), node.predicate)) {
      streak += 1;
      if (streak > longest) longest = streak;
    } else {
      streak = 0;
    }
  }
  return longest >= node.min_len;
}

function evalScalar(rows: readonly ScreenRow[], node: DslScalar): Dec | Na {
  switch (node.kind) {
    case 'field':
      return rowValue(rows[rows.length - 1]!, node.field);
    case 'const':
      return new D(node.value);
    case 'agg':
      return evalAggregate(rows, node);
    case 'period_return':
      return evalPeriodReturn(rows, node.window.days);
    case 'scale': {
      const inner = evalScalar(rows, node.inner);
      if (inner === NA) return NA;
      return inner.mul(new D(node.factor));
    }
    default: {
      const exhaustive: never = node;
      throw new QuantError(
        'EVALUATION_FAILED',
        `unhandled scalar kind: ${JSON.stringify(exhaustive)}`,
        {},
      );
    }
  }
}

function evalAggregate(
  rows: readonly ScreenRow[],
  node: Extract<DslScalar, { kind: 'agg' }>,
): Dec | Na {
  const days = node.window.days;
  if (rows.length < days) return NA;
  const window = rows.slice(rows.length - days);
  const values: Dec[] = [];
  for (const r of window) {
    const v = rowValue(r, node.field);
    if (v === NA) continue;
    values.push(v);
  }
  if (!isAggOp(node.agg)) {
    throw new QuantError('EVALUATION_FAILED', `unhandled agg: ${node.agg}`, {});
  }
  if (node.agg === 'count') return new D(values.length);
  if (values.length === 0) return NA;
  switch (node.agg) {
    case 'mean': {
      const sum = values.reduce<Dec>((acc, v) => acc.add(v), new D(0));
      return sum.div(values.length);
    }
    case 'sum':
      return values.reduce<Dec>((acc, v) => acc.add(v), new D(0));
    case 'min':
      return values.reduce<Dec>((acc, v) => (v.lt(acc) ? v : acc), values[0]!);
    case 'max':
      return values.reduce<Dec>((acc, v) => (v.gt(acc) ? v : acc), values[0]!);
  }
}

function evalPeriodReturn(rows: readonly ScreenRow[], days: number): Dec | Na {
  if (rows.length < days + 1) return NA;
  const end = rows[rows.length - 1]!.close_qfq;
  const startRow = rows[rows.length - 1 - days];
  if (startRow === undefined) return NA;
  if (end === null || startRow.close_qfq === null) return NA;
  const startDec = new D(startRow.close_qfq);
  if (startDec.eq(0)) return NA;
  return new D(end).sub(startDec).div(startDec);
}

function rowValue(row: ScreenRow, field: string): Dec | Na {
  const v = (row as unknown as Record<string, unknown>)[field];
  if (v === undefined || v === null) return NA;
  if (typeof v === 'number') return new D(v);
  if (typeof v === 'string') return new D(v);
  return NA;
}

function isCompareOp(op: string): op is CompareOp {
  return op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte' || op === 'eq' || op === 'neq';
}

function isAggOp(op: string): op is AggOp {
  return op === 'mean' || op === 'sum' || op === 'min' || op === 'max' || op === 'count';
}
