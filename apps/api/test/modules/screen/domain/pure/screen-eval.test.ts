/**
 * Unit tests for the screen DSL evaluator. Mirrors the Python
 * `services/py/tests/unit/quant_core/domain/rules/test_screen_eval.py`
 * groupings so drift between the two implementations surfaces fast.
 */

import type { DslPredicate, DslScalar } from '@quant/shared';

import {
  evaluatePredicate,
  evaluateScalar,
  type ScreenRow,
} from '../../../../../src/modules/screen/domain/pure/screen-eval.js';

function row(
  trade_date: string,
  fields: Partial<ScreenRow> = {},
): ScreenRow {
  return {
    trade_date,
    open_qfq: 10,
    high_qfq: 10,
    low_qfq: 10,
    close_qfq: 10,
    volume: 0,
    amount: 0,
    turnover_rate: 0,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
    pct_chg_qfq: null,
    ...fields,
  };
}

function field(name: string): DslScalar {
  return { kind: 'field', field: name };
}
function constant(value: string): DslScalar {
  return { kind: 'const', value };
}
function compare(op: string, left: DslScalar, right: DslScalar): DslPredicate {
  return { kind: 'compare', op, left, right };
}

describe('evaluatePredicate — Compare', () => {
  it('gt: field > const matches when latest close > 5', () => {
    const rows = [row('2026-01-01', { close_qfq: 7 })];
    expect(evaluatePredicate(rows, compare('gt', field('close_qfq'), constant('5')))).toBe(true);
  });

  it('compare against null field is false', () => {
    const rows = [row('2026-01-01', { ma60: null })];
    expect(evaluatePredicate(rows, compare('gt', field('ma60'), constant('5')))).toBe(false);
  });

  it('empty rows is false', () => {
    expect(evaluatePredicate([], compare('gt', field('close_qfq'), constant('5')))).toBe(false);
  });

  it('eq / neq', () => {
    const rows = [row('2026-01-01', { close_qfq: 5 })];
    expect(evaluatePredicate(rows, compare('eq', field('close_qfq'), constant('5')))).toBe(true);
    expect(evaluatePredicate(rows, compare('neq', field('close_qfq'), constant('5')))).toBe(false);
  });
});

describe('evaluatePredicate — Logical', () => {
  const rows = [row('2026-01-01', { close_qfq: 10, volume: 1000 })];
  it('and short-circuits to true', () => {
    const pred: DslPredicate = {
      kind: 'logical',
      op: 'and',
      args: [
        compare('gt', field('close_qfq'), constant('5')),
        compare('gt', field('volume'), constant('100')),
      ],
    };
    expect(evaluatePredicate(rows, pred)).toBe(true);
  });
  it('or with mixed truth', () => {
    const pred: DslPredicate = {
      kind: 'logical',
      op: 'or',
      args: [
        compare('gt', field('close_qfq'), constant('999')),
        compare('gt', field('volume'), constant('100')),
      ],
    };
    expect(evaluatePredicate(rows, pred)).toBe(true);
  });
  it('not inverts', () => {
    const pred: DslPredicate = {
      kind: 'logical',
      op: 'not',
      args: [compare('gt', field('close_qfq'), constant('999'))],
    };
    expect(evaluatePredicate(rows, pred)).toBe(true);
  });
});

describe('evaluatePredicate — ForAll / Exists', () => {
  const rows = [
    row('2026-01-01', { close_qfq: 11 }),
    row('2026-01-02', { close_qfq: 12 }),
    row('2026-01-03', { close_qfq: 13 }),
  ];
  it('for_all: every bar in window satisfies pred', () => {
    const pred: DslPredicate = {
      kind: 'for_all',
      window: { days: 3 },
      predicate: compare('gt', field('close_qfq'), constant('10')),
    };
    expect(evaluatePredicate(rows, pred)).toBe(true);
  });
  it('for_all: any failing bar → false', () => {
    const pred: DslPredicate = {
      kind: 'for_all',
      window: { days: 3 },
      predicate: compare('gt', field('close_qfq'), constant('12.5')),
    };
    expect(evaluatePredicate(rows, pred)).toBe(false);
  });
  it('for_all: insufficient rows → false', () => {
    const pred: DslPredicate = {
      kind: 'for_all',
      window: { days: 5 },
      predicate: compare('gt', field('close_qfq'), constant('1')),
    };
    expect(evaluatePredicate(rows, pred)).toBe(false);
  });
  it('exists: at least one bar in window satisfies', () => {
    const pred: DslPredicate = {
      kind: 'exists',
      window: { days: 3 },
      predicate: compare('gt', field('close_qfq'), constant('12.5')),
    };
    expect(evaluatePredicate(rows, pred)).toBe(true);
  });
});

describe('evaluatePredicate — Consecutive', () => {
  it('detects a 3-day streak', () => {
    const rows = [
      row('2026-01-01', { close_qfq: 9 }), // fails
      row('2026-01-02', { close_qfq: 11 }), // passes
      row('2026-01-03', { close_qfq: 12 }), // passes
      row('2026-01-04', { close_qfq: 13 }), // passes
      row('2026-01-05', { close_qfq: 9 }), // resets
    ];
    const pred: DslPredicate = {
      kind: 'consecutive',
      min_len: 3,
      predicate: compare('gt', field('close_qfq'), constant('10')),
    };
    expect(evaluatePredicate(rows, pred)).toBe(true);
  });

  it('streak shorter than min_len → false', () => {
    const rows = [
      row('2026-01-01', { close_qfq: 11 }),
      row('2026-01-02', { close_qfq: 11 }),
      row('2026-01-03', { close_qfq: 9 }),
    ];
    const pred: DslPredicate = {
      kind: 'consecutive',
      min_len: 3,
      predicate: compare('gt', field('close_qfq'), constant('10')),
    };
    expect(evaluatePredicate(rows, pred)).toBe(false);
  });
});

describe('evaluateScalar — Aggregate', () => {
  const rows = [
    row('2026-01-01', { volume: 100 }),
    row('2026-01-02', { volume: 200 }),
    row('2026-01-03', { volume: 300 }),
  ];
  it('mean over the window', () => {
    const s: DslScalar = { kind: 'agg', agg: 'mean', field: 'volume', window: { days: 3 } };
    expect(evaluateScalar(rows, s)?.toString()).toBe('200');
  });
  it('sum over the window', () => {
    const s: DslScalar = { kind: 'agg', agg: 'sum', field: 'volume', window: { days: 3 } };
    expect(evaluateScalar(rows, s)?.toString()).toBe('600');
  });
  it('min / max over the window', () => {
    expect(evaluateScalar(rows, { kind: 'agg', agg: 'min', field: 'volume', window: { days: 3 } })?.toString()).toBe('100');
    expect(evaluateScalar(rows, { kind: 'agg', agg: 'max', field: 'volume', window: { days: 3 } })?.toString()).toBe('300');
  });
  it('count includes only non-null bars', () => {
    const sparse = [
      row('2026-01-01', { ma60: null }),
      row('2026-01-02', { ma60: 12 }),
      row('2026-01-03', { ma60: 13 }),
    ];
    expect(
      evaluateScalar(sparse, { kind: 'agg', agg: 'count', field: 'ma60', window: { days: 3 } })?.toString(),
    ).toBe('2');
  });
  it('insufficient rows → null', () => {
    expect(
      evaluateScalar(rows, { kind: 'agg', agg: 'mean', field: 'volume', window: { days: 5 } }),
    ).toBeNull();
  });
});

describe('evaluateScalar — PeriodReturn', () => {
  const rows = [
    row('2026-01-01', { close_qfq: 10 }),
    row('2026-01-02', { close_qfq: 11 }),
    row('2026-01-03', { close_qfq: 12 }),
  ];
  it('2-day return uses bar 2 positions back', () => {
    const s: DslScalar = { kind: 'period_return', window: { days: 2 } };
    expect(evaluateScalar(rows, s)?.toString()).toBe('0.2');
  });
  it('insufficient rows → null', () => {
    const s: DslScalar = { kind: 'period_return', window: { days: 5 } };
    expect(evaluateScalar(rows, s)).toBeNull();
  });
  it('zero base close → null', () => {
    const halted = [row('2026-01-01', { close_qfq: 0 }), row('2026-01-02', { close_qfq: 5 })];
    expect(evaluateScalar(halted, { kind: 'period_return', window: { days: 1 } })).toBeNull();
  });
});

describe('evaluateScalar — Scale', () => {
  it('multiplies the inner scalar', () => {
    const rows = [row('2026-01-01', { close_qfq: 10 })];
    const s: DslScalar = { kind: 'scale', inner: field('close_qfq'), factor: '1.05' };
    expect(evaluateScalar(rows, s)?.toString()).toBe('10.5');
  });
  it('propagates NA from inner', () => {
    const rows = [row('2026-01-01', { ma60: null })];
    const s: DslScalar = { kind: 'scale', inner: field('ma60'), factor: '1.05' };
    expect(evaluateScalar(rows, s)).toBeNull();
  });
});
