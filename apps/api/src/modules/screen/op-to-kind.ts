/**
 * LLM-output (`op`-tagged) → wire-format (`kind`-tagged) DSL converter.
 *
 * The NL→DSL prompt (mirroring the Python version) instructs the model to
 * emit nodes in `op`-tagged form (`{op: 'gt', left, right}`); the existing
 * Python `screen_run` Flight op consumes the `kind`-tagged wire form
 * (`{kind: 'compare', op: 'gt', left, right}`). This module is the
 * single point of translation, ported from `quant_core.domain.rules.
 * screen_parse` + `universe_parse`.
 *
 * Pure: no IO, no logging, no globals. Throws `QuantError("DSL_INVALID")`
 * with a JSON-pointer `path` field on every structural problem so the
 * NL→DSL service can hand the error back to the LLM on retry.
 */

import {
  QuantError,
  type DslPredicate,
  type DslScalar,
  type RankSpecView,
  type ScreenPlanAst,
  type UniverseExpr,
  type UniversePlanAst,
} from '@quant/shared';

const SCREEN_FIELD_NAMES: ReadonlySet<string> = new Set([
  'open',
  'high',
  'low',
  'close',
  'open_qfq',
  'high_qfq',
  'low_qfq',
  'close_qfq',
  'volume',
  'amount',
  'turnover_rate',
  'ma5',
  'ma10',
  'ma20',
  'ma60',
  'pct_chg_qfq',
]);

const UNIVERSE_FIELDS: ReadonlySet<string> = new Set([
  'code',
  'name',
  'industries',
  'list_date',
  'float_pct',
  'is_st',
  'exchange',
  'listed_days',
]);

const COMPARE_OPS: ReadonlySet<string> = new Set(['gt', 'lt', 'gte', 'lte', 'eq', 'neq']);
const LOGICAL_OPS: ReadonlySet<string> = new Set(['and', 'or', 'not']);
const AGG_OPS: ReadonlySet<string> = new Set(['mean', 'sum', 'min', 'max', 'count']);
const UNIVERSE_COMPARE_OPS: ReadonlySet<string> = new Set([
  'gt',
  'lt',
  'gte',
  'lte',
  'eq',
  'neq',
  'contains',
  'starts_with',
  'not_starts_with',
]);

const ASOF_RE = /^\d{4}-\d{2}-\d{2}$/u;
const RANK_ORDERS: ReadonlySet<string> = new Set(['asc', 'desc']);

// ---------------------------------------------------------------------------
// public entry points
// ---------------------------------------------------------------------------

export function convertScreenPlanFromOpTagged(raw: unknown): ScreenPlanAst {
  if (!isRecord(raw)) throw invalid('/', 'screen_plan must be an object');
  const asof = parseAsof(raw['asof'], '/asof');
  const expr = convertPredicate(raw['expr'], '/expr');
  return { asof, expr };
}

export function convertUniversePlanFromOpTagged(raw: unknown): UniversePlanAst {
  if (!isRecord(raw)) throw invalid('/', 'universe_plan must be an object');
  const asof = parseAsof(raw['asof'], '/asof');
  const expr = convertUniverseExpr(raw['expr'], '/expr');
  return { asof, expr };
}

export function convertRankFromOpTagged(raw: unknown): RankSpecView {
  if (!isRecord(raw)) throw invalid('/rank', 'rank must be an object');
  const metric = convertScalar(raw['metric'], '/rank/metric');
  const orderRaw = raw['order'] ?? 'desc';
  if (typeof orderRaw !== 'string' || !RANK_ORDERS.has(orderRaw)) {
    throw invalid('/rank/order', `rank.order must be 'asc' or 'desc', got ${String(orderRaw)}`);
  }
  const topNRaw = raw['top_n'];
  let topN: number | null = null;
  if (topNRaw !== undefined && topNRaw !== null) {
    if (typeof topNRaw !== 'number' || !Number.isInteger(topNRaw) || topNRaw < 0) {
      throw invalid(
        '/rank/top_n',
        `rank.top_n must be a non-negative int or null, got ${String(topNRaw)}`,
      );
    }
    topN = topNRaw;
  }
  return {
    metric,
    order: orderRaw === 'asc' ? 'asc' : 'desc',
    topN,
  };
}

// ---------------------------------------------------------------------------
// predicate (kline)
// ---------------------------------------------------------------------------

function convertPredicate(raw: unknown, path: string): DslPredicate {
  if (!isRecord(raw)) throw invalid(path, 'predicate must be an object');
  const op = raw['op'];
  if (typeof op !== 'string') throw invalid(path, "predicate is missing string 'op'");
  if (LOGICAL_OPS.has(op)) return convertLogical(raw, path, op);
  if (COMPARE_OPS.has(op)) return convertCompare(raw, path, op);
  if (op === 'for_all' || op === 'exists') return convertWindowAssertion(raw, path, op);
  if (op === 'consecutive') return convertConsecutive(raw, path);
  throw invalid(path, `unknown op ${op}`);
}

function convertLogical(
  raw: Readonly<Record<string, unknown>>,
  path: string,
  op: string,
): DslPredicate {
  const argsRaw = raw['args'];
  if (!Array.isArray(argsRaw) || argsRaw.length === 0) {
    throw invalid(path, `logical op '${op}' requires non-empty 'args' list`);
  }
  if (op === 'not' && argsRaw.length !== 1) {
    throw invalid(path, "logical 'not' must have exactly one arg");
  }
  const args = argsRaw.map((a, i) => convertPredicate(a, `${path}/args/${String(i)}`));
  return { kind: 'logical', op: op as 'and' | 'or' | 'not', args };
}

function convertCompare(
  raw: Readonly<Record<string, unknown>>,
  path: string,
  op: string,
): DslPredicate {
  const left = convertScalar(raw['left'], `${path}/left`);
  const right = convertScalar(raw['right'], `${path}/right`);
  return { kind: 'compare', op, left, right };
}

function convertWindowAssertion(
  raw: Readonly<Record<string, unknown>>,
  path: string,
  op: 'for_all' | 'exists',
): DslPredicate {
  const days = parseWindowDays(raw['window'], path);
  const predRaw = raw['predicate'];
  if (predRaw === undefined) throw invalid(path, `'${op}' requires 'predicate'`);
  const inner = convertPredicate(predRaw, `${path}/predicate`);
  return { kind: op, window: { days }, predicate: inner };
}

function convertConsecutive(raw: Readonly<Record<string, unknown>>, path: string): DslPredicate {
  const minLen = raw['min_len'];
  if (typeof minLen !== 'number' || !Number.isInteger(minLen) || minLen <= 0) {
    throw invalid(path, 'consecutive.min_len must be a positive int');
  }
  const predRaw = raw['predicate'];
  if (predRaw === undefined) throw invalid(path, "consecutive requires 'predicate'");
  const inner = convertPredicate(predRaw, `${path}/predicate`);
  return { kind: 'consecutive', min_len: minLen, predicate: inner };
}

// ---------------------------------------------------------------------------
// scalar
// ---------------------------------------------------------------------------

export function convertScalar(raw: unknown, path: string): DslScalar {
  if (!isRecord(raw)) throw invalid(path, 'scalar must be an object');
  // Discriminator order matches Python `_parse_scalar`.
  if ('scale' in raw) return convertScale(raw['scale'], path);
  if ('agg' in raw) return convertAggregate(raw, path);
  if ('indicator' in raw) return convertIndicator(raw, path);
  if ('period_return' in raw) return convertPeriodReturn(raw['period_return'], path);
  if ('const' in raw) return { kind: 'const', value: parseDecimalString(raw['const'], path) };
  if ('field' in raw) {
    const name = raw['field'];
    if (typeof name !== 'string' || !SCREEN_FIELD_NAMES.has(name)) {
      throw invalid(path, `unknown field ${String(name)}`);
    }
    return { kind: 'field', field: name };
  }
  throw invalid(path, 'scalar must be one of: field/const/agg/period_return/indicator/scale');
}

function convertAggregate(raw: Readonly<Record<string, unknown>>, path: string): DslScalar {
  const agg = raw['agg'];
  if (typeof agg !== 'string' || !AGG_OPS.has(agg))
    throw invalid(path, `unknown agg ${String(agg)}`);
  const field = raw['field'];
  if (typeof field !== 'string' || !SCREEN_FIELD_NAMES.has(field)) {
    throw invalid(path, `unknown field ${String(field)}`);
  }
  const days = parseWindowDays(raw['window'], path);
  return { kind: 'agg', agg, field, window: { days } };
}

function convertPeriodReturn(rawWindow: unknown, path: string): DslScalar {
  if (!isRecord(rawWindow)) throw invalid(path, 'period_return must take a window dict');
  const days = rawWindow['days'];
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
    throw invalid(path, 'period_return.days must be a positive int');
  }
  return { kind: 'period_return', window: { days } };
}

function convertScale(rawScale: unknown, path: string): DslScalar {
  if (!isRecord(rawScale)) throw invalid(path, "scale must be an object with 'inner' and 'factor'");
  const innerRaw = rawScale['inner'];
  if (innerRaw === undefined) throw invalid(path, "scale requires 'inner' scalar");
  const inner = convertScalar(innerRaw, `${path}/inner`);
  if (!('factor' in rawScale)) throw invalid(path, "scale requires 'factor'");
  const factor = parseDecimalString(rawScale['factor'], `${path}/factor`);
  // We store factor as a stringified Decimal on the wire — match Python.
  // Reject zero / negative factors (Python parity).
  if (Number(factor) <= 0)
    throw invalid(`${path}/factor`, `scale.factor must be > 0, got ${factor}`);
  return { kind: 'scale', inner, factor };
}

function convertIndicator(raw: Readonly<Record<string, unknown>>, path: string): DslScalar {
  // v1: collapse `indicator: "ma" period=N` to the precomputed `maN` field.
  const name = raw['indicator'];
  if (name !== 'ma') throw invalid(path, `indicator ${String(name)} not supported in v1`);
  const period = raw['period'];
  if (period !== 5 && period !== 10 && period !== 20 && period !== 60) {
    throw invalid(path, 'indicator.period must be one of 5/10/20/60 in v1');
  }
  return { kind: 'field', field: `ma${String(period)}` };
}

// ---------------------------------------------------------------------------
// universe
// ---------------------------------------------------------------------------

function convertUniverseExpr(raw: unknown, path: string): UniverseExpr {
  if (!isRecord(raw)) throw invalid(path, 'universe expr must be an object');
  const op = raw['op'];
  if (typeof op !== 'string') throw invalid(path, "universe expr is missing string 'op'");
  if (LOGICAL_OPS.has(op)) {
    const argsRaw = raw['args'];
    if (!Array.isArray(argsRaw) || argsRaw.length === 0) {
      throw invalid(path, `logical op '${op}' requires non-empty 'args' list`);
    }
    if (op === 'not' && argsRaw.length !== 1) {
      throw invalid(path, "logical 'not' must have exactly one arg");
    }
    const args = argsRaw.map((a, i) => convertUniverseExpr(a, `${path}/args/${String(i)}`));
    return { kind: 'logical', op: op as 'and' | 'or' | 'not', args };
  }
  if (UNIVERSE_COMPARE_OPS.has(op)) return convertUniverseCompare(raw, path, op);
  throw invalid(path, `unknown universe op ${op}`);
}

function convertUniverseCompare(
  raw: Readonly<Record<string, unknown>>,
  path: string,
  op: string,
): UniverseExpr {
  const leftRaw = raw['left'];
  if (!isRecord(leftRaw) || !('field' in leftRaw)) {
    throw invalid(`${path}/left`, "universe compare 'left' must be a field reference");
  }
  const fieldName = leftRaw['field'];
  if (typeof fieldName !== 'string' || !UNIVERSE_FIELDS.has(fieldName)) {
    throw invalid(`${path}/left`, `unknown universe field ${String(fieldName)}`);
  }
  const rightRaw = raw['right'];
  if (!isRecord(rightRaw) || !('const' in rightRaw)) {
    throw invalid(`${path}/right`, "universe compare 'right' must be {const: ...}");
  }
  const value = parseUniverseConst(rightRaw['const'], fieldName, `${path}/right`);
  return {
    kind: 'compare',
    op,
    left: { kind: 'field', field: fieldName },
    right: { kind: 'const', value },
  };
}

const STRING_FIELDS: ReadonlySet<string> = new Set(['code', 'name', 'industries', 'exchange']);

function parseUniverseConst(raw: unknown, field: string, path: string): unknown {
  if (field === 'is_st') {
    if (typeof raw !== 'boolean') throw invalid(path, 'is_st const must be a bool');
    return raw;
  }
  if (STRING_FIELDS.has(field)) {
    if (typeof raw !== 'string') throw invalid(path, `${field} const must be a string`);
    return raw;
  }
  if (field === 'list_date') {
    if (typeof raw !== 'string' || !ASOF_RE.test(raw)) {
      throw invalid(path, `list_date const must be ISO YYYY-MM-DD, got ${String(raw)}`);
    }
    return raw;
  }
  if (field === 'listed_days') {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      throw invalid(path, 'listed_days const must be an int');
    }
    return raw;
  }
  if (field === 'float_pct') {
    return parseDecimalString(raw, path);
  }
  throw invalid(path, `unsupported field ${field}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseWindowDays(window: unknown, path: string): number {
  if (!isRecord(window)) throw invalid(path, "window must be an object with 'days'");
  const days = window['days'];
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
    throw invalid(path, `window.days must be a positive int, got ${String(days)}`);
  }
  return days;
}

function parseDecimalString(raw: unknown, path: string): string {
  if (typeof raw === 'boolean') throw invalid(path, 'const must be a number, not bool');
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw invalid(path, `const must be finite, got ${String(raw)}`);
    return String(raw);
  }
  if (typeof raw === 'string') {
    if (!/^-?\d+(\.\d+)?$/u.test(raw)) {
      throw invalid(path, `const not parseable as decimal: ${raw}`);
    }
    return raw;
  }
  throw invalid(path, `const must be a number, got ${typeof raw}`);
}

function parseAsof(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !ASOF_RE.test(raw)) {
    throw invalid(path, `asof must be ISO YYYY-MM-DD, got ${String(raw)}`);
  }
  return raw;
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalid(path: string, message: string): QuantError {
  return new QuantError('DSL_INVALID', message, { path });
}
