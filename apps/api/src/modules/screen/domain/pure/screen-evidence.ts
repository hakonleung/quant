/**
 * Build the per-stock evidence dict that the screen result carries.
 * Port of `_build_evidence`, `_collect_compare_scalars`, `_scalar_label`,
 * `_evidence_value` from `screen_service.py`.
 *
 * For every Scalar that drives a `Compare` in the predicate (Const
 * skipped), the evaluator emits its value under a deterministic label
 * so the UI can render "why did this code match" without re-running
 * the AST. Quantised to 4dp uniformly across every metric type.
 */

import type { DslPredicate, DslScalar } from '@quant/shared';

import { type Dec } from '../../../../common/decimal.js';
import { evaluateScalar, type ScreenRow } from './screen-eval.js';

export interface Evidence {
  readonly window: readonly [string, string] | readonly [];
  readonly metrics: Record<string, string | null>;
  readonly rank_metric?: string | null;
}

export function buildEvidence(rows: readonly ScreenRow[], pred: DslPredicate): Evidence {
  if (rows.length === 0) return { window: [], metrics: {} };
  const first = rows[0]!.trade_date;
  const last = rows[rows.length - 1]!.trade_date;
  const metrics: Record<string, string | null> = {};
  for (const scalar of collectCompareScalars(pred)) {
    const name = scalarLabel(scalar);
    if (name === null || name in metrics) continue;
    metrics[name] = evidenceValue(evaluateScalar(rows, scalar));
  }
  return { window: [first, last], metrics };
}

export function evidenceValue(v: Dec | null): string | null {
  if (v === null) return null;
  // Mirror Py's `value.quantize(Decimal("0.0001"))` with HALF_EVEN.
  return v.toDecimalPlaces(4, 6 /* ROUND_HALF_EVEN */).toFixed(4);
}

export function scalarLabel(scalar: DslScalar): string | null {
  switch (scalar.kind) {
    case 'field':
      return scalar.field;
    case 'universe_field':
      return scalar.field;
    case 'agg':
      return `${scalar.agg}_${scalar.field}_${String(scalar.window.days)}d`;
    case 'period_return':
      return `period_return_${String(scalar.window.days)}d`;
    case 'scale': {
      const inner = scalarLabel(scalar.inner);
      return inner === null ? null : `${inner}_x${scalar.factor}`;
    }
    case 'const':
      return null;
  }
}

export function collectCompareScalars(pred: DslPredicate): DslScalar[] {
  const out: DslScalar[] = [];
  walk(pred, out);
  return out;
}

function walk(node: DslPredicate, out: DslScalar[]): void {
  switch (node.kind) {
    case 'compare':
      for (const side of [node.left, node.right] as const) {
        if (side.kind !== 'const') out.push(side);
      }
      return;
    case 'logical':
      for (const a of node.args) walk(a, out);
      return;
    case 'for_all':
    case 'exists':
    case 'consecutive':
      walk(node.predicate, out);
  }
}
