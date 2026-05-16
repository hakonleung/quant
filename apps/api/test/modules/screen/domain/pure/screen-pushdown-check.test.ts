/**
 * Tests for `canPushdown`. Supported shapes are exercised transitively
 * by `screen-parity.spec.ts`; this file pins the rejection rules so the
 * fallback to the interpreter remains predictable.
 */

import type { DslPredicate } from '@quant/shared';

import { canPushdown } from '../../../../../src/modules/screen/domain/pure/screen-pushdown-check.js';

describe('canPushdown — rejection rules', () => {
  it('rejects Aggregate nested inside ForAll inner', () => {
    const node: DslPredicate = {
      kind: 'for_all',
      window: { days: 5 },
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'agg', agg: 'mean', field: 'close_qfq', window: { days: 5 } },
        right: { kind: 'const', value: '10' },
      },
    };
    expect(canPushdown(node)).toBe(false);
  });

  it('rejects PeriodReturn nested inside Consecutive inner', () => {
    const node: DslPredicate = {
      kind: 'consecutive',
      min_len: 3,
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'period_return', window: { days: 5 } },
        right: { kind: 'const', value: '0' },
      },
    };
    expect(canPushdown(node)).toBe(false);
  });

  it('rejects ForAll nested inside ForAll', () => {
    const inner: DslPredicate = {
      kind: 'for_all',
      window: { days: 3 },
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'volume' },
        right: { kind: 'const', value: '0' },
      },
    };
    const outer: DslPredicate = {
      kind: 'for_all',
      window: { days: 5 },
      predicate: inner,
    };
    expect(canPushdown(outer)).toBe(false);
  });

  it('accepts Scale wrapping an Aggregate at the top level', () => {
    const node: DslPredicate = {
      kind: 'compare',
      op: 'gt',
      left: {
        kind: 'scale',
        inner: { kind: 'agg', agg: 'mean', field: 'close_qfq', window: { days: 5 } },
        factor: '1.05',
      },
      right: { kind: 'field', field: 'close_qfq' },
    };
    expect(canPushdown(node)).toBe(true);
  });

  it('accepts Logical(and) wrapping mixed top-level branches', () => {
    const node: DslPredicate = {
      kind: 'logical',
      op: 'and',
      args: [
        {
          kind: 'consecutive',
          min_len: 3,
          predicate: {
            kind: 'compare',
            op: 'gt',
            left: { kind: 'field', field: 'volume' },
            right: { kind: 'const', value: '1' },
          },
        },
        {
          kind: 'compare',
          op: 'gt',
          left: { kind: 'agg', agg: 'sum', field: 'amount', window: { days: 20 } },
          right: { kind: 'const', value: '0' },
        },
      ],
    };
    expect(canPushdown(node)).toBe(true);
  });
});
