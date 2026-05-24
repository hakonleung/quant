/**
 * Plan-signature hash (SHA-256 of canonical JSON). Port of
 * `screen_service.plan_signature` — the canonical shape mirrors the Py
 * version exactly so signatures stay byte-identical across the
 * Py-to-NestJS migration (callers cache result by this hash).
 *
 * The Py canonical form is **not** the wire format (which is
 * `kind`-tagged). It uses keyed dicts like `{"field": "close_qfq"}` /
 * `{"const": "1"}` and `op`-tagged predicates. The shape below mirrors
 * `_node_to_jsonable` / `_scalar_to_jsonable` in screen_service.py.
 */

import { createHash } from 'node:crypto';

import {
  QuantError,
  type DslPredicate,
  type DslScalar,
  type RankSpecView,
  type ScreenPlanAst,
} from '@quant/shared';

export function planSignature(plan: ScreenPlanAst, rank: RankSpecView | null = null): string {
  const payload: Record<string, unknown> = {
    asof: plan.asof,
    expr: nodeToCanonical(plan.expr),
  };
  if (rank !== null) {
    payload['rank'] = {
      metric: scalarToCanonical(rank.metric),
      order: rank.order,
      top_n: rank.topN,
    };
  }
  const canonical = canonicalJsonStringify(payload);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

function nodeToCanonical(node: DslPredicate): Record<string, unknown> {
  switch (node.kind) {
    case 'compare':
      return {
        op: node.op,
        left: scalarToCanonical(node.left),
        right: scalarToCanonical(node.right),
      };
    case 'logical':
      return { op: node.op, args: node.args.map(nodeToCanonical) };
    case 'for_all':
      return {
        op: 'for_all',
        window: { days: node.window.days },
        predicate: nodeToCanonical(node.predicate),
      };
    case 'exists':
      return {
        op: 'exists',
        window: { days: node.window.days },
        predicate: nodeToCanonical(node.predicate),
      };
    case 'consecutive':
      return {
        op: 'consecutive',
        min_len: node.min_len,
        predicate: nodeToCanonical(node.predicate),
      };
  }
}

function scalarToCanonical(node: DslScalar): Record<string, unknown> {
  switch (node.kind) {
    case 'field':
      return { field: node.field };
    case 'universe_field':
      return { universe_field: node.field };
    case 'const':
      return { const: node.value };
    case 'agg':
      return {
        agg: node.agg,
        field: node.field,
        window: { days: node.window.days },
      };
    case 'period_return':
      return { period_return: { days: node.window.days } };
    case 'scale':
      return {
        scale: {
          inner: scalarToCanonical(node.inner),
          factor: node.factor,
        },
      };
  }
}

/**
 * Mirrors `json.dumps(payload, sort_keys=True, separators=(",", ":"))`.
 *
 * - Keys at every nesting level are sorted alphabetically.
 * - No whitespace between tokens.
 * - Strings are JSON-escaped via the standard rules (`JSON.stringify`).
 * - Numbers use JS's default `.toString()` — matches Python's
 *   `json.dumps` for integers and most floats encountered in DSL
 *   payloads (window days are ints; floats are rare and only appear as
 *   stringified Decimals in `const` / `factor`).
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new QuantError('DSL_INVALID', `non-finite number in signature payload: ${value}`, {});
    }
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const inner = keys
      .map((k) => {
        const v = (value as Record<string, unknown>)[k];
        return `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`;
      })
      .join(',');
    return `{${inner}}`;
  }
  throw new QuantError('DSL_INVALID', `cannot serialise ${typeof value} for signature`, {});
}
