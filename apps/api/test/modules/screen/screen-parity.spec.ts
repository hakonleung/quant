/**
 * Parity test: every supported pushdown shape must produce the same
 * matched code set as the TS interpreter.
 *
 * Builds a small synthetic kline parquet (3 codes × 30 trade days),
 * then for each plan runs:
 *
 *   - `compilePushdownSql` → DuckDB SELECT → matched codes
 *   - `evaluatePredicate` per code → matched codes
 *
 * and asserts the two sets are equal. The kline shape mirrors what
 * `KlineReaderService.bulkRangeForScreen` returns (qfq fields + the
 * synthesised pct_chg_qfq column), so interpreter input matches what
 * ScreenExecService would feed it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { DslPredicate } from '@quant/shared';

import {
  evaluatePredicate,
  type ScreenRow,
} from '../../../src/modules/screen/domain/pure/screen-eval.js';
import { canPushdown } from '../../../src/modules/screen/domain/pure/screen-pushdown-check.js';
import { compilePushdownSql } from '../../../src/modules/screen/domain/pure/screen-sql-codegen.js';

const ASOF = '2026-02-01';

interface SeedBar {
  readonly code: string;
  readonly trade_date: string;
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
}

/**
 * 3 codes × 30 days, hand-tuned so each plan below has at least one
 * match and at least one non-match. Dates 2026-01-03..2026-02-01.
 *
 * - C001: monotonically rising close 10 → 39 (close_qfq), ma5 always
 *   lower than close after day 5, low turnover.
 * - C002: U-shaped close (15 → 5 → 15), high volume.
 * - C003: flat at 20 with a single 3-day spike at days 10..12, volume
 *   sometimes > 1e7.
 */
function seedBars(): SeedBar[] {
  const out: SeedBar[] = [];
  function bar(
    code: string,
    dayOffset: number,
    close: number,
    volume: number,
    ma5: number | null,
  ): SeedBar {
    const base = new Date('2026-01-03T00:00:00Z');
    const d = new Date(base.getTime() + dayOffset * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    return {
      code,
      trade_date: iso,
      open_qfq: close,
      high_qfq: close,
      low_qfq: close,
      close_qfq: close,
      volume,
      amount: close * volume,
      turnover_rate: 0.01,
      ma5,
      ma10: null,
      ma20: null,
      ma60: null,
    };
  }
  // C001 — monotone rising; ma5 below close from day 5 onwards.
  for (let i = 0; i < 30; i += 1) {
    const close = 10 + i;
    const ma5 = i >= 4 ? close - 2 : null;
    out.push(bar('000001', i, close, 1_000_000, ma5));
  }
  // C002 — U shape.
  for (let i = 0; i < 30; i += 1) {
    const close = i < 15 ? 15 - i * 0.5 : 7.5 + (i - 15) * 0.5;
    out.push(bar('000002', i, +close.toFixed(2), 50_000_000, +close.toFixed(2)));
  }
  // C003 — flat at 20 with a 3-day spike.
  for (let i = 0; i < 30; i += 1) {
    const inSpike = i >= 10 && i <= 12;
    out.push(bar('000003', i, 20, inSpike ? 20_000_000 : 5_000_000, 20));
  }
  return out;
}

function toScreenRows(bars: readonly SeedBar[]): Record<string, readonly ScreenRow[]> {
  const out: Record<string, ScreenRow[]> = {};
  // Group by code, ordered by date (already in order from seedBars).
  for (const b of bars) {
    const bucket = out[b.code];
    const prev = bucket?.[bucket.length - 1];
    const pctChg =
      prev !== undefined && prev.close_qfq > 0
        ? (b.close_qfq - prev.close_qfq) / prev.close_qfq
        : null;
    const row: ScreenRow = {
      trade_date: b.trade_date,
      open_qfq: b.open_qfq,
      high_qfq: b.high_qfq,
      low_qfq: b.low_qfq,
      close_qfq: b.close_qfq,
      volume: b.volume,
      amount: b.amount,
      turnover_rate: b.turnover_rate,
      ma5: b.ma5,
      ma10: b.ma10,
      ma20: b.ma20,
      ma60: b.ma60,
      pct_chg_qfq: pctChg,
    };
    if (bucket === undefined) out[b.code] = [row];
    else bucket.push(row);
  }
  return out;
}

async function writeParquet(
  conn: DuckDBConnection,
  path: string,
  bars: readonly SeedBar[],
): Promise<void> {
  await conn.run(`
    CREATE TABLE seed (
      code VARCHAR, ts DATE,
      open_qfq DOUBLE, high_qfq DOUBLE, low_qfq DOUBLE, close_qfq DOUBLE,
      volume BIGINT, amount DOUBLE, turnover_rate DOUBLE,
      ma5 DOUBLE, ma10 DOUBLE, ma20 DOUBLE, ma60 DOUBLE
    );
  `);
  const rowSqls = bars.map((b) => {
    const o = String(b.open_qfq);
    const h = String(b.high_qfq);
    const l = String(b.low_qfq);
    const c = String(b.close_qfq);
    const v = String(b.volume);
    const a = String(b.amount);
    const t = String(b.turnover_rate);
    const m5 = b.ma5 === null ? 'NULL' : String(b.ma5);
    return `('${b.code}', DATE '${b.trade_date}', ${o}, ${h}, ${l}, ${c}, ${v}, ${a}, ${t}, ${m5}, NULL, NULL, NULL)`;
  });
  await conn.run(`INSERT INTO seed VALUES ${rowSqls.join(',\n')};`);
  await conn.run(`COPY seed TO '${path}' (FORMAT PARQUET);`);
  await conn.run('DROP TABLE seed;');
}

interface ParityCase {
  readonly label: string;
  readonly predicate: DslPredicate;
}

const CASES: readonly ParityCase[] = [
  {
    label: 'simple compare: close_qfq > 25',
    predicate: {
      kind: 'compare',
      op: 'gt',
      left: { kind: 'field', field: 'close_qfq' },
      right: { kind: 'const', value: '25' },
    },
  },
  {
    label: 'compare against another field (close > ma5)',
    predicate: {
      kind: 'compare',
      op: 'gt',
      left: { kind: 'field', field: 'close_qfq' },
      right: { kind: 'field', field: 'ma5' },
    },
  },
  {
    label: 'aggregate mean(close_qfq, 5) > 20',
    predicate: {
      kind: 'compare',
      op: 'gt',
      left: { kind: 'agg', agg: 'mean', field: 'close_qfq', window: { days: 5 } },
      right: { kind: 'const', value: '20' },
    },
  },
  {
    label: 'aggregate min(volume, 10) > 1e6',
    predicate: {
      kind: 'compare',
      op: 'gt',
      left: { kind: 'agg', agg: 'min', field: 'volume', window: { days: 10 } },
      right: { kind: 'const', value: '1000000' },
    },
  },
  {
    label: 'aggregate count(ma5, 5) >= 5 (ma5 sometimes null)',
    predicate: {
      kind: 'compare',
      op: 'gte',
      left: { kind: 'agg', agg: 'count', field: 'ma5', window: { days: 5 } },
      right: { kind: 'const', value: '5' },
    },
  },
  {
    label: 'period_return(5) > 0.10',
    predicate: {
      kind: 'compare',
      op: 'gt',
      left: { kind: 'period_return', window: { days: 5 } },
      right: { kind: 'const', value: '0.10' },
    },
  },
  {
    label: 'scale: close_qfq * 1.05 > ma5 * 1.10',
    predicate: {
      kind: 'compare',
      op: 'gt',
      left: { kind: 'scale', inner: { kind: 'field', field: 'close_qfq' }, factor: '1.05' },
      right: { kind: 'scale', inner: { kind: 'field', field: 'ma5' }, factor: '1.10' },
    },
  },
  {
    label: 'for_all 5d (close > ma5)',
    predicate: {
      kind: 'for_all',
      window: { days: 5 },
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'close_qfq' },
        right: { kind: 'field', field: 'ma5' },
      },
    },
  },
  {
    label: 'exists 5d (volume > 1.5e7)',
    predicate: {
      kind: 'exists',
      window: { days: 5 },
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'volume' },
        right: { kind: 'const', value: '15000000' },
      },
    },
  },
  {
    label: 'consecutive 3d (volume > 1.5e7)',
    predicate: {
      kind: 'consecutive',
      min_len: 3,
      predicate: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'volume' },
        right: { kind: 'const', value: '15000000' },
      },
    },
  },
  {
    label: 'logical and (close > 25) AND for_all 5d (close > ma5)',
    predicate: {
      kind: 'logical',
      op: 'and',
      args: [
        {
          kind: 'compare',
          op: 'gt',
          left: { kind: 'field', field: 'close_qfq' },
          right: { kind: 'const', value: '25' },
        },
        {
          kind: 'for_all',
          window: { days: 5 },
          predicate: {
            kind: 'compare',
            op: 'gt',
            left: { kind: 'field', field: 'close_qfq' },
            right: { kind: 'field', field: 'ma5' },
          },
        },
      ],
    },
  },
  {
    label: 'logical or + not',
    predicate: {
      kind: 'logical',
      op: 'or',
      args: [
        {
          kind: 'logical',
          op: 'not',
          args: [
            {
              kind: 'compare',
              op: 'gt',
              left: { kind: 'field', field: 'close_qfq' },
              right: { kind: 'const', value: '100' },
            },
          ],
        },
        {
          kind: 'compare',
          op: 'lt',
          left: { kind: 'field', field: 'volume' },
          right: { kind: 'const', value: '500000' },
        },
      ],
    },
  },
];

describe('screen pushdown ↔ interpreter parity', () => {
  let tmp: string;
  let parquet: string;
  let conn: DuckDBConnection;
  const bars = seedBars();
  const rowsByCode = toScreenRows(bars);
  const codes = Array.from(new Set(bars.map((b) => b.code)));

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'screen-parity-'));
    parquet = join(tmp, 'kline.parquet');
    const inst = await DuckDBInstance.create(':memory:');
    conn = await inst.connect();
    await writeParquet(conn, parquet, bars);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  for (const c of CASES) {
    it(`parity: ${c.label}`, async () => {
      expect(canPushdown(c.predicate)).toBe(true);

      // Interpreter side.
      const interpreterMatches = new Set<string>();
      for (const code of codes) {
        const rows = rowsByCode[code] ?? [];
        if (evaluatePredicate(rows, c.predicate)) interpreterMatches.add(code);
      }

      // Pushdown side.
      const { sql } = compilePushdownSql({
        asof: ASOF,
        start: '2026-01-03',
        universe: codes,
        predicate: c.predicate,
        klineParquetGlob: parquet,
      });
      const result = await conn.runAndReadAll(sql);
      const sqlMatches = new Set<string>();
      for (const row of result.getRowObjects()) {
        const code = (row as Record<string, unknown>)['code'];
        if (typeof code === 'string') sqlMatches.add(code);
      }

      expect(Array.from(sqlMatches).sort()).toEqual(Array.from(interpreterMatches).sort());
    });
  }
});
