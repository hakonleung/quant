/**
 * Snapshot-style tests on the codegen output: every node kind produces
 * the expected SQL fragments. Catches syntax-level regressions without
 * needing a real DuckDB connection.
 *
 * Full semantic parity (interpreter vs pushdown matches the same code
 * set) lives in `test/modules/screen/screen-parity.spec.ts`.
 */

import type { ScreenPlanAst } from '@quant/shared';

import { compilePushdownSql } from '../../../../../src/modules/screen/domain/pure/screen-sql-codegen.js';

const ASOF = '2026-05-15';
const START = '2026-01-01';
const KLINE = '/tmp/kline/*.parquet';
const UNI = ['600519', '000001'];

function compile(predicate: ScreenPlanAst['expr']): string {
  return compilePushdownSql({
    asof: ASOF,
    start: START,
    universe: UNI,
    predicate,
    klineParquetGlob: KLINE,
  }).sql;
}

describe('compilePushdownSql', () => {
  it('emits read_parquet, bars CTE, and asof filter', () => {
    const sql = compile({
      kind: 'compare',
      op: 'gt',
      left: { kind: 'field', field: 'close_qfq' },
      right: { kind: 'const', value: '50' },
    });
    expect(sql).toContain(`read_parquet('${KLINE}')`);
    expect(sql).toContain("ts BETWEEN DATE '2026-01-01' AND DATE '2026-05-15'");
    // The asof bar per code is selected via rn_desc=1 (latest row in
    // window), not by literal asof — halted / delisted codes still
    // evaluate at their last bar, matching the interpreter.
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY code ORDER BY ts DESC\) AS rn_desc/);
    expect(sql).toContain('WHERE a.rn_desc = 1');
    expect(sql).toContain("'600519'");
    expect(sql).toContain("'000001'");
  });

  it('Compare wraps both sides with IS NOT NULL', () => {
    const sql = compile({
      kind: 'compare',
      op: 'gt',
      left: { kind: 'field', field: 'close_qfq' },
      right: { kind: 'const', value: '50' },
    });
    expect(sql).toContain('IS NOT NULL');
    expect(sql).toMatch(/a\."close_qfq" IS NOT NULL/);
  });

  it('Aggregate emits a window AVG with a row-bounded frame + insufficient-bar guard', () => {
    const sql = compile({
      kind: 'compare',
      op: 'gt',
      left: { kind: 'agg', agg: 'mean', field: 'close_qfq', window: { days: 20 } },
      right: { kind: 'const', value: '30' },
    });
    expect(sql).toMatch(
      /AVG\("close_qfq"\) OVER \(PARTITION BY code ORDER BY ts ROWS 19 PRECEDING\)/,
    );
    // Outer gate: window must hold at least `days` (=20) rows.
    expect(sql).toMatch(/COUNT\(\*\) OVER[^>]*>= 20/);
  });

  it('PeriodReturn emits LAG with NULLIF guard', () => {
    const sql = compile({
      kind: 'compare',
      op: 'gt',
      left: { kind: 'period_return', window: { days: 5 } },
      right: { kind: 'const', value: '0.05' },
    });
    expect(sql).toMatch(/LAG\(close_qfq, 5\) OVER w_code/);
    expect(sql).toMatch(/NULLIF\(LAG\(close_qfq, 5\) OVER w_code, 0\)/);
  });

  it('Scale multiplies the inner by the factor', () => {
    const sql = compile({
      kind: 'compare',
      op: 'gt',
      left: {
        kind: 'scale',
        inner: { kind: 'field', field: 'close_qfq' },
        factor: '1.05',
      },
      right: { kind: 'field', field: 'ma20' },
    });
    expect(sql).toMatch(/\(a\."close_qfq" \* CAST\('1\.05' AS DOUBLE\)\)/);
  });

  it('ForAll uses a SUM-over-N-1-preceding equals N + bars_total guard', () => {
    const sql = compile({
      kind: 'for_all',
      window: { days: 5 },
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'close_qfq' },
        right: { kind: 'field', field: 'ma5' },
      },
    });
    expect(sql).toMatch(
      /SUM\("pred_\d+"\) OVER \(PARTITION BY code ORDER BY ts ROWS 4 PRECEDING\)/,
    );
    expect(sql).toContain('a.bars_total >= 5');
    expect(sql).toMatch(/a\."forall_sum_\d+" = 5/);
  });

  it('Exists uses MAX over N-1 preceding = 1', () => {
    const sql = compile({
      kind: 'exists',
      window: { days: 3 },
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'volume' },
        right: { kind: 'const', value: '10000000' },
      },
    });
    expect(sql).toMatch(
      /MAX\("pred_\d+"\) OVER \(PARTITION BY code ORDER BY ts ROWS 2 PRECEDING\)/,
    );
    expect(sql).toMatch(/a\."exists_max_\d+" = 1/);
  });

  it('Consecutive emits a streaks CTE + LEFT JOIN', () => {
    const sql = compile({
      kind: 'consecutive',
      min_len: 3,
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'volume' },
        right: { kind: 'const', value: '10000000' },
      },
    });
    expect(sql).toMatch(/streaks_\d+ AS/);
    expect(sql).toMatch(/cons_\d+ AS/);
    expect(sql).toMatch(/LEFT JOIN cons_\d+ ON cons_\d+\.code = a\.code/);
    expect(sql).toMatch(/COALESCE\(cons_\d+\."cons_max_\d+", 0\) >= 3/);
  });

  it('Logical AND/OR/NOT combine sub-expressions', () => {
    const sql = compile({
      kind: 'logical',
      op: 'and',
      args: [
        {
          kind: 'compare',
          op: 'gt',
          left: { kind: 'field', field: 'close_qfq' },
          right: { kind: 'const', value: '10' },
        },
        {
          kind: 'logical',
          op: 'not',
          args: [
            {
              kind: 'compare',
              op: 'lt',
              left: { kind: 'field', field: 'volume' },
              right: { kind: 'const', value: '0' },
            },
          ],
        },
      ],
    });
    expect(sql).toMatch(/\) AND \(/);
    expect(sql).toMatch(/NOT \(/);
  });
});
