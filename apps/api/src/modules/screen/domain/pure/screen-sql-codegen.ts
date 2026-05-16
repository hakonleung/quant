/**
 * Compile a `ScreenPlanAst` into a single DuckDB SELECT that returns
 * matched codes. The codegen is row-vectorised: every Compare /
 * Aggregate / PeriodReturn becomes a column in the `bars` CTE, and
 * the per-code match boolean is evaluated by selecting the asof bar.
 *
 * Supported AST shapes are gated by `screen-pushdown-check.ts`; this
 * module assumes the predicate is supported and treats anything
 * unsupported as an internal error. Wire it through
 * `ScreenExecService` only via the `canPushdown` guard.
 *
 * NULL semantics: Py's `_NA` (missing field on a fresh listing,
 * insufficient bars for an aggregate) makes Compare return false.
 * SQL NULL would make the predicate NULL (UNKNOWN) — we wrap every
 * Compare with `<expr> IS NOT NULL AND <expr> <op> <other>` so the
 * result is a true boolean, matching the interpreter.
 *
 * Numeric model: DOUBLE throughout (matches the parquet storage type).
 * Parity tests against the Decimal-based interpreter cover the
 * threshold-near-boundary cases; we only escalate to DECIMAL casts
 * for a specific expression if a test catches drift.
 */

import { QuantError, type DslPredicate, type DslScalar } from '@quant/shared';

import { SCREEN_FIELD_SET } from './screen-fields.js';

export interface CodegenInput {
  readonly asof: string; // ISO YYYY-MM-DD
  readonly start: string; // ISO YYYY-MM-DD (inclusive lower bound for the bars window)
  readonly universe: readonly string[];
  readonly predicate: DslPredicate;
  /** Absolute path glob handed to `read_parquet`. */
  readonly klineParquetGlob: string;
}

export interface CodegenOutput {
  readonly sql: string;
}

/**
 * Top-level entry. Throws `QuantError("DSL_INVALID")` if the predicate
 * contains a shape the codegen doesn't support — callers must filter
 * with `canPushdown` first.
 */
export function compilePushdownSql(input: CodegenInput): CodegenOutput {
  if (input.universe.length === 0) {
    throw new QuantError('DSL_INVALID', 'compilePushdownSql requires a non-empty universe', {});
  }
  const ctx = new CodegenCtx();
  const matchExpr = compilePredicate(input.predicate, ctx);
  return { sql: assembleSql(input, ctx, matchExpr) };
}

function assembleSql(input: CodegenInput, ctx: CodegenCtx, matchExpr: string): string {
  const rowExprs = ctx.rowExprs.map((r) => `${r.expr} AS ${quoteIdent(r.alias)}`).join(',\n      ');
  const consecutiveCtes = ctx.consecutiveBranches.map((b) => buildConsecutiveCte(b)).join(',\n');
  const consecutiveJoins = ctx.consecutiveBranches
    .map((b) => `LEFT JOIN ${b.cteName} ON ${b.cteName}.code = a.code`)
    .join('\n      ');
  const universeList = input.universe.map((c) => quoteLiteral(c)).join(', ');
  const klineSource = `read_parquet(${quoteLiteral(input.klineParquetGlob)})`;
  const consecutiveCteBlock = consecutiveCtes.length > 0 ? `,\n${consecutiveCtes}` : '';
  return `
    WITH bars AS (
      SELECT
        code,
        ts,
        open_qfq,
        high_qfq,
        low_qfq,
        close_qfq,
        volume,
        amount,
        turnover_rate,
        ma5,
        ma10,
        ma20,
        ma60,
        (close_qfq - LAG(close_qfq) OVER w_code) /
          NULLIF(LAG(close_qfq) OVER w_code, 0) AS pct_chg_qfq,
        COUNT(*) OVER w_code_unb AS bars_total,
        -- rn_desc=1 marks the latest bar per code; the interpreter
        -- evaluates the plan at rows[-1] regardless of asof.
        ROW_NUMBER() OVER (PARTITION BY code ORDER BY ts DESC) AS rn_desc${rowExprs.length > 0 ? ',' : ''}
    ${rowExprs}
      FROM ${klineSource}
      WHERE code IN (${universeList})
        AND ts BETWEEN DATE ${quoteLiteral(input.start)} AND DATE ${quoteLiteral(input.asof)}
      WINDOW
        w_code AS (PARTITION BY code ORDER BY ts),
        w_code_unb AS (PARTITION BY code ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    )${consecutiveCteBlock}
    SELECT DISTINCT a.code
    FROM bars AS a
    ${consecutiveJoins}
    WHERE a.rn_desc = 1
      AND (${matchExpr});
  `;
}

// ---------------------------------------------------------------------------
// codegen context: name allocator + accumulators
// ---------------------------------------------------------------------------

interface RowExpr {
  readonly alias: string;
  readonly expr: string;
}

interface ConsecutiveBranch {
  readonly cteName: string;
  /** Row-level boolean column in `bars`. */
  readonly innerBoolAlias: string;
  /** Group-id column in `bars`. */
  readonly groupIdAlias: string;
  /** Per-code max-streak column exposed by the CTE. */
  readonly maxStreakAlias: string;
}

class CodegenCtx {
  readonly rowExprs: RowExpr[] = [];
  readonly consecutiveBranches: ConsecutiveBranch[] = [];
  private counter = 0;

  nextId(): number {
    this.counter += 1;
    return this.counter;
  }

  addRowExpr(alias: string, expr: string): string {
    this.rowExprs.push({ alias, expr });
    return alias;
  }
}

function buildConsecutiveCte(b: ConsecutiveBranch): string {
  return `
        streaks_${b.cteName.replace(/^cons_/, '')} AS (
          SELECT code, ${quoteIdent(b.groupIdAlias)} AS grp, COUNT(*) AS len
          FROM bars
          WHERE ${quoteIdent(b.innerBoolAlias)} = 1
          GROUP BY code, ${quoteIdent(b.groupIdAlias)}
        ),
        ${b.cteName} AS (
          SELECT code, MAX(len) AS ${quoteIdent(b.maxStreakAlias)}
          FROM streaks_${b.cteName.replace(/^cons_/, '')}
          GROUP BY code
        )`.trim();
}

// ---------------------------------------------------------------------------
// predicate compilation: returns a boolean SQL expression evaluated at
// the asof bar of each code. References to the `bars`-CTE alias use
// `a.<col>` since the outer SELECT aliases bars as `a`.
// ---------------------------------------------------------------------------

function compilePredicate(node: DslPredicate, ctx: CodegenCtx): string {
  switch (node.kind) {
    case 'compare':
      return compileCompareAtAsof(node, ctx);
    case 'logical':
      return compileLogical(node, ctx);
    case 'for_all':
      return compileForAll(node, ctx);
    case 'exists':
      return compileExists(node, ctx);
    case 'consecutive':
      return compileConsecutive(node, ctx);
  }
}

function compileLogical(node: Extract<DslPredicate, { kind: 'logical' }>, ctx: CodegenCtx): string {
  if (node.op === 'not') {
    const first = node.args[0];
    if (first === undefined) {
      throw new QuantError('DSL_INVALID', "logical 'not' requires an arg", {});
    }
    return `(NOT (${compilePredicate(first, ctx)}))`;
  }
  const joined = node.args
    .map((a) => `(${compilePredicate(a, ctx)})`)
    .join(node.op === 'and' ? ' AND ' : ' OR ');
  return joined.length > 0 ? joined : node.op === 'and' ? 'TRUE' : 'FALSE';
}

function compileCompareAtAsof(
  node: Extract<DslPredicate, { kind: 'compare' }>,
  ctx: CodegenCtx,
): string {
  const lhs = compileScalar(node.left, ctx, 'a');
  const rhs = compileScalar(node.right, ctx, 'a');
  return wrapCompare(lhs, node.op, rhs);
}

function compileForAll(node: Extract<DslPredicate, { kind: 'for_all' }>, ctx: CodegenCtx): string {
  const days = node.window.days;
  // Inner predicate is row-level (guaranteed by canPushdown). Build per-row
  // boolean as an int in the bars CTE so we can sum it over the window.
  const innerBool = compileInnerBool(node.predicate, ctx);
  const sumAlias = `forall_sum_${String(ctx.nextId())}`;
  ctx.addRowExpr(
    sumAlias,
    `SUM(${quoteIdent(innerBool)}) OVER (PARTITION BY code ORDER BY ts ROWS ${String(days - 1)} PRECEDING)`,
  );
  // At asof bar: bars_total >= days AND sum over the trailing N == N.
  return `(a.bars_total >= ${String(days)} AND a.${quoteIdent(sumAlias)} = ${String(days)})`;
}

function compileExists(node: Extract<DslPredicate, { kind: 'exists' }>, ctx: CodegenCtx): string {
  const days = node.window.days;
  const innerBool = compileInnerBool(node.predicate, ctx);
  const maxAlias = `exists_max_${String(ctx.nextId())}`;
  ctx.addRowExpr(
    maxAlias,
    `MAX(${quoteIdent(innerBool)}) OVER (PARTITION BY code ORDER BY ts ROWS ${String(days - 1)} PRECEDING)`,
  );
  return `(a.bars_total >= ${String(days)} AND a.${quoteIdent(maxAlias)} = 1)`;
}

function compileConsecutive(
  node: Extract<DslPredicate, { kind: 'consecutive' }>,
  ctx: CodegenCtx,
): string {
  const innerBoolAlias = compileInnerBool(node.predicate, ctx);
  const id = String(ctx.nextId());
  const groupAlias = `cons_grp_${id}`;
  // Group-id flips every time the inner predicate fails; SUM of (1-bool)
  // gives a unique id per consecutive run. Equivalent to Py's
  // "streak / max" loop in screen_eval._eval_consecutive.
  ctx.addRowExpr(
    groupAlias,
    `SUM(CASE WHEN ${quoteIdent(innerBoolAlias)} = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY code ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`,
  );
  const cteName = `cons_${id}`;
  const maxStreakAlias = `cons_max_${id}`;
  ctx.consecutiveBranches.push({
    cteName,
    innerBoolAlias,
    groupIdAlias: groupAlias,
    maxStreakAlias,
  });
  return `(COALESCE(${cteName}.${quoteIdent(maxStreakAlias)}, 0) >= ${String(node.min_len)})`;
}

/**
 * Compile a row-level predicate (Compare / Logical of Compares) into a
 * single 0/1 column in the bars CTE; return the column alias.
 * NULL row values yield 0 (matches Py NA → false). Guaranteed by
 * canPushdown that no Aggregate/PeriodReturn appears inside.
 */
function compileInnerBool(predicate: DslPredicate, ctx: CodegenCtx): string {
  const alias = `pred_${String(ctx.nextId())}`;
  ctx.addRowExpr(alias, `CASE WHEN ${rowLevelBoolExpr(predicate, ctx)} THEN 1 ELSE 0 END`);
  return alias;
}

function rowLevelBoolExpr(node: DslPredicate, ctx: CodegenCtx): string {
  switch (node.kind) {
    case 'compare':
      return rowLevelCompareExpr(node, ctx);
    case 'logical':
      return rowLevelLogicalExpr(node, ctx);
    case 'for_all':
    case 'exists':
    case 'consecutive':
      throw new QuantError(
        'DSL_INVALID',
        'window assertion nested inside ForAll/Exists/Consecutive — should have been filtered by canPushdown',
        {},
      );
  }
}

function rowLevelCompareExpr(
  node: Extract<DslPredicate, { kind: 'compare' }>,
  ctx: CodegenCtx,
): string {
  const lhs = compileScalar(node.left, ctx, null);
  const rhs = compileScalar(node.right, ctx, null);
  return wrapCompare(lhs, node.op, rhs);
}

function rowLevelLogicalExpr(
  node: Extract<DslPredicate, { kind: 'logical' }>,
  ctx: CodegenCtx,
): string {
  if (node.op === 'not') {
    const first = node.args[0];
    if (first === undefined) {
      throw new QuantError('DSL_INVALID', "logical 'not' requires an arg", {});
    }
    return `(NOT (${rowLevelBoolExpr(first, ctx)}))`;
  }
  const joined = node.args
    .map((a) => `(${rowLevelBoolExpr(a, ctx)})`)
    .join(node.op === 'and' ? ' AND ' : ' OR ');
  return joined.length > 0 ? joined : node.op === 'and' ? 'TRUE' : 'FALSE';
}

/**
 * Compile a scalar expression. Returns a SQL fragment that yields a
 * numeric value (possibly NULL).
 *
 * `tableAlias` is the alias to qualify field references against (e.g.
 * `a` when we're at the asof-bar level); when `null`, references are
 * un-qualified (used inside `bars` row expressions where the CTE row
 * is the current scope).
 */
function compileScalar(node: DslScalar, ctx: CodegenCtx, tableAlias: string | null): string {
  switch (node.kind) {
    case 'field': {
      if (!SCREEN_FIELD_SET.has(node.field)) {
        throw new QuantError('DSL_INVALID', `unknown screen field: ${node.field}`, {});
      }
      return tableAlias === null
        ? quoteIdent(node.field)
        : `${tableAlias}.${quoteIdent(node.field)}`;
    }
    case 'const':
      // Cast as DOUBLE for numeric ordering; parity tests will surface
      // any precision issue and we can switch to DECIMAL casts there.
      return `CAST(${quoteLiteral(node.value)} AS DOUBLE)`;
    case 'agg':
      return compileAggregate(node, ctx, tableAlias);
    case 'period_return':
      return compilePeriodReturn(node.window.days, ctx, tableAlias);
    case 'scale': {
      const inner = compileScalar(node.inner, ctx, tableAlias);
      return `(${inner} * CAST(${quoteLiteral(node.factor)} AS DOUBLE))`;
    }
  }
}

function compileAggregate(
  node: Extract<DslScalar, { kind: 'agg' }>,
  ctx: CodegenCtx,
  tableAlias: string | null,
): string {
  if (!SCREEN_FIELD_SET.has(node.field)) {
    throw new QuantError('DSL_INVALID', `unknown screen field: ${node.field}`, {});
  }
  const days = node.window.days;
  const id = String(ctx.nextId());
  const alias = `agg_${node.agg}_${node.field}_${String(days)}_${id}`;
  const sqlFn = aggSqlFn(node.agg);
  const baseCol = quoteIdent(node.field);
  // Aggregate semantics (mirror screen_eval._eval_aggregate):
  //   - If window < `days` rows total → NA.
  //   - count: number of non-NA values in the window (only if gate passes).
  //   - mean/sum/min/max: NA if every value was NA, else apply the fn.
  // DuckDB window aggregates ignore NULLs by default for AVG/SUM/MIN/MAX,
  // so the outer gate is enough — the only NA-only case is when
  // COUNT(field) OVER w = 0.
  const windowSpec = `PARTITION BY code ORDER BY ts ROWS ${String(days - 1)} PRECEDING`;
  const rowCountExpr = `COUNT(*) OVER (${windowSpec})`;
  const nonNullCountExpr = `COUNT(${baseCol}) OVER (${windowSpec})`;
  const expr =
    node.agg === 'count'
      ? `CASE WHEN ${rowCountExpr} >= ${String(days)}
              THEN ${nonNullCountExpr} ELSE NULL END`
      : `CASE WHEN ${rowCountExpr} >= ${String(days)} AND ${nonNullCountExpr} >= 1
              THEN ${sqlFn}(${baseCol}) OVER (${windowSpec})
              ELSE NULL END`;
  ctx.addRowExpr(alias, expr);
  return tableAlias === null ? quoteIdent(alias) : `${tableAlias}.${quoteIdent(alias)}`;
}

function aggSqlFn(agg: string): string {
  switch (agg) {
    case 'mean':
      return 'AVG';
    case 'sum':
      return 'SUM';
    case 'min':
      return 'MIN';
    case 'max':
      return 'MAX';
    case 'count':
      return 'COUNT';
    default:
      throw new QuantError('DSL_INVALID', `unknown agg: ${agg}`, {});
  }
}

function compilePeriodReturn(days: number, ctx: CodegenCtx, tableAlias: string | null): string {
  const id = String(ctx.nextId());
  const alias = `period_return_${String(days)}_${id}`;
  // (close - close N bars ago) / close N bars ago; null if N-back bar
  // missing or its close is non-positive (matches Py).
  const expr = `(close_qfq - LAG(close_qfq, ${String(days)}) OVER w_code) /
                  NULLIF(LAG(close_qfq, ${String(days)}) OVER w_code, 0)`;
  ctx.addRowExpr(alias, expr);
  return tableAlias === null ? quoteIdent(alias) : `${tableAlias}.${quoteIdent(alias)}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function wrapCompare(lhs: string, op: string, rhs: string): string {
  const cmpOp = sqlCmpOp(op);
  // NULL on either side → false (NA semantics).
  return `(${lhs} IS NOT NULL AND ${rhs} IS NOT NULL AND ${lhs} ${cmpOp} ${rhs})`;
}

function sqlCmpOp(op: string): string {
  switch (op) {
    case 'gt':
      return '>';
    case 'lt':
      return '<';
    case 'gte':
      return '>=';
    case 'lte':
      return '<=';
    case 'eq':
      return '=';
    case 'neq':
      return '<>';
    default:
      throw new QuantError('DSL_INVALID', `unknown compare op: ${op}`, {});
  }
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
