/**
 * Walk a screen AST and decide whether the SQL codegen can handle it.
 *
 * Supported shapes (covered by `screen-sql-codegen.ts`):
 *   - Top level: Logical(and|or|not) / Compare / ForAll / Exists /
 *     Consecutive (recursively, with `Logical` allowed at any depth).
 *   - Inside ForAll / Exists / Consecutive's inner predicate: only
 *     row-level expressions are allowed — Compare or Logical of
 *     Compares. Aggregate / PeriodReturn nested inside a window
 *     assertion would change which rows feed the inner aggregate
 *     (see `screen_eval._eval_for_all`'s `window[: i + 1]` slicing),
 *     and the SQL equivalent is significantly more complex; those
 *     plans fall back to the interpreter.
 *   - Compare sides may use Field / Const / Aggregate / PeriodReturn /
 *     Scale.
 *
 * Anything else returns false, and the executor takes the interpreter
 * path. The parity tests guard that both paths produce the same
 * matches for supported shapes.
 */

import type { DslPredicate, DslScalar } from '@quant/shared';

export function canPushdown(predicate: DslPredicate): boolean {
  return walkOuter(predicate);
}

function walkOuter(node: DslPredicate): boolean {
  switch (node.kind) {
    case 'compare':
      return scalarOk(node.left) && scalarOk(node.right);
    case 'logical':
      return node.args.every(walkOuter);
    case 'for_all':
    case 'exists':
    case 'consecutive':
      return walkInner(node.predicate);
  }
}

function walkInner(node: DslPredicate): boolean {
  switch (node.kind) {
    case 'compare':
      return scalarRowLevel(node.left) && scalarRowLevel(node.right);
    case 'logical':
      return node.args.every(walkInner);
    case 'for_all':
    case 'exists':
    case 'consecutive':
      // Nesting two window assertions is theoretically expressible
      // but rare and would require a chain of window CTEs. Fall back.
      return false;
  }
}

function scalarOk(node: DslScalar): boolean {
  switch (node.kind) {
    case 'field':
    case 'const':
    case 'agg':
    case 'period_return':
      return true;
    case 'universe_field':
      // Universe fields resolve per-code from the snapshot map; the
      // kline SQL codegen has no way to join that in. Fall back to the
      // interpreter, where the rank step will handle it.
      return false;
    case 'scale':
      return scalarOk(node.inner);
  }
}

function scalarRowLevel(node: DslScalar): boolean {
  switch (node.kind) {
    case 'field':
    case 'const':
      return true;
    case 'agg':
    case 'period_return':
    case 'universe_field':
      return false;
    case 'scale':
      return scalarRowLevel(node.inner);
  }
}
