/**
 * Walk a screen AST to collect required kline columns + max lookback
 * (in bars). Port of `screen_compile.summarise` — used by the executor
 * to trim the universe slice's column projection and date range.
 */

import type { DslPredicate, DslScalar } from '@quant/shared';

export interface CompileSummary {
  readonly columns: ReadonlySet<string>;
  /**
   * Max bars of history the predicate touches, including the asof bar.
   * 1 = "only asof"; ForAll(days=5) = 5; PeriodReturn(days=20) = 21.
   */
  readonly lookbackDays: number;
}

export function summarise(predicate: DslPredicate): CompileSummary {
  const cols = new Set<string>();
  const lookback = walk(predicate, cols);
  return { columns: cols, lookbackDays: Math.max(lookback, 1) };
}

function walk(node: DslPredicate, cols: Set<string>): number {
  switch (node.kind) {
    case 'compare':
      return Math.max(scalar(node.left, cols), scalar(node.right, cols));
    case 'logical': {
      let m = 1;
      for (const a of node.args) {
        const v = walk(a, cols);
        if (v > m) m = v;
      }
      return m;
    }
    case 'for_all':
      return Math.max(node.window.days, walk(node.predicate, cols));
    case 'exists':
      return Math.max(node.window.days, walk(node.predicate, cols));
    case 'consecutive':
      // Consecutive scans the whole stored window; its own lookback is
      // a lower bound. Callers widen via the executor's calendar buffer.
      return walk(node.predicate, cols);
  }
}

function scalar(node: DslScalar, cols: Set<string>): number {
  switch (node.kind) {
    case 'field':
      cols.add(node.field);
      return 1;
    case 'universe_field':
      // Universe scalars don't touch the kline column set; they resolve
      // per-code from the snapshot map. Lookback is zero — the value is
      // a single number, not a windowed series.
      return 1;
    case 'const':
      return 1;
    case 'agg':
      cols.add(node.field);
      return node.window.days;
    case 'period_return':
      cols.add('close_qfq');
      return node.window.days + 1;
    case 'scale':
      return scalar(node.inner, cols);
  }
}
