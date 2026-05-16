/**
 * Baseline benchmark for the in-process screen executor.
 *
 * Goal: lock in the current `ScreenExecService` wall-clock budget so a
 * future DSL→DuckDB SQL pushdown change (Phase 3) can compare against
 * concrete numbers per CLAUDE.md §9.4.
 *
 * Construction: this script bypasses the NestJS DI container and
 * `new`s the relevant classes directly with the production adapters
 * (DuckDB-backed kline store + meta parquet). The bench reads the
 * canonical `data/` directory; pass `--data-root` to override.
 *
 * Run:
 *   pnpm --filter @quant/api tsx scripts/bench-screen.ts \
 *     [--data-root /path/to/data] [--runs 10] [--warmup 3]
 *
 * Output: each plan's p50 / p95 wall time (ms) over the measured runs
 * + match count. Suitable as the "before" row in
 * docs/perf/screen-pushdown.md.
 */

import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { DuckDBParquetTimeSeriesStore } from '../src/common/storage/adapters/duckdb-parquet-time-series.store.js';
import { KlineReaderService } from '../src/modules/kline/kline-reader.service.js';
import { KLINE_COLUMNS, KLINE_TABLE_NAME, type KlineRow } from '../src/modules/kline/kline.row.js';
import { LocalStockMetaAdapter } from '../src/modules/stock-meta/local-stock-meta.adapter.js';
import { ScreenExecService } from '../src/modules/screen/screen-exec.service.js';
import { UniverseFilterService } from '../src/modules/screen/universe-filter.service.js';

import type { ScreenPlanAst, UniversePlanAst, RankSpecView } from '@quant/shared';

interface Args {
  readonly dataRoot: string;
  readonly runs: number;
  readonly warmup: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let dataRoot = join(process.cwd(), '..', '..', 'data');
  let runs = 10;
  let warmup = 3;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--data-root' && value !== undefined) {
      dataRoot = value;
      i += 1;
    } else if (flag === '--runs' && value !== undefined) {
      runs = Number.parseInt(value, 10);
      i += 1;
    } else if (flag === '--warmup' && value !== undefined) {
      warmup = Number.parseInt(value, 10);
      i += 1;
    }
  }
  return { dataRoot, runs, warmup };
}

interface PlanCase {
  readonly label: string;
  readonly plan: ScreenPlanAst;
  readonly universe: UniversePlanAst | null;
  readonly rank: RankSpecView | null;
}

function planCases(asof: string): readonly PlanCase[] {
  return [
    {
      label: 'simple-compare (close_qfq > 50)',
      plan: {
        asof,
        expr: {
          kind: 'compare',
          op: 'gt',
          left: { kind: 'field', field: 'close_qfq' },
          right: { kind: 'const', value: '50' },
        },
      },
      universe: null,
      rank: null,
    },
    {
      label: 'aggregate (mean(close_qfq, 20) > 30)',
      plan: {
        asof,
        expr: {
          kind: 'compare',
          op: 'gt',
          left: {
            kind: 'agg',
            agg: 'mean',
            field: 'close_qfq',
            window: { days: 20 },
          },
          right: { kind: 'const', value: '30' },
        },
      },
      universe: null,
      rank: null,
    },
    {
      label: 'for_all 5d (close_qfq > ma5)',
      plan: {
        asof,
        expr: {
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
      universe: null,
      rank: null,
    },
    {
      label: 'consecutive 3d (volume > 1e7) + rank',
      plan: {
        asof,
        expr: {
          kind: 'consecutive',
          min_len: 3,
          predicate: {
            kind: 'compare',
            op: 'gt',
            left: { kind: 'field', field: 'volume' },
            right: { kind: 'const', value: '10000000' },
          },
        },
      },
      universe: null,
      rank: {
        metric: { kind: 'period_return', window: { days: 20 } },
        order: 'desc',
        topN: 50,
      },
    },
  ];
}

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(((sorted.length - 1) * p) / 100));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `bench-screen: dataRoot=${args.dataRoot} warmup=${args.warmup} runs=${args.runs}`,
  );

  // The store joins `dataRoot + table` internally → data/kline.
  const klineStore = new DuckDBParquetTimeSeriesStore<KlineRow>({
    dataRoot: args.dataRoot,
    table: KLINE_TABLE_NAME,
    columns: KLINE_COLUMNS,
  });
  const klineReader = new KlineReaderService(klineStore);
  const metaAdapter = new LocalStockMetaAdapter(args.dataRoot);
  const universeFilter = new UniverseFilterService(metaAdapter);
  const exec = new ScreenExecService(klineReader, metaAdapter, universeFilter);

  // Pick the freshest trade date across the loaded meta universe so we
  // exercise the real tail without hard-coding a probe code.
  const metas = await metaAdapter.listAll();
  if (metas.length === 0) {
    console.error('no meta rows — data root looks empty');
    process.exit(2);
  }
  const watermarks = await klineStore.lastTimestamps(metas.map((m) => m.code));
  let latest: Date | null = null;
  for (const ts of watermarks.values()) {
    if (latest === null || ts.getTime() > latest.getTime()) latest = ts;
  }
  if (latest === null) {
    console.error('no kline watermarks — kline store is empty');
    process.exit(2);
  }
  const asof = latest.toISOString().slice(0, 10);
  console.log(`asof=${asof}\n`);

  const cases = planCases(asof);
  for (const c of cases) {
    // Warmup (DuckDB connection pool / FS cache).
    for (let i = 0; i < args.warmup; i += 1) {
      await exec.execute(c.plan, c.universe, c.rank);
    }
    const samples: number[] = [];
    let matches = 0;
    for (let i = 0; i < args.runs; i += 1) {
      const t0 = performance.now();
      const result = await exec.execute(c.plan, c.universe, c.rank);
      samples.push(performance.now() - t0);
      matches = result.matches.length;
    }
    samples.sort((a, b) => a - b);
    const p50 = pct(samples, 50);
    const p95 = pct(samples, 95);
    console.log(
      `[${c.label}] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms matches=${matches}`,
    );
  }
}

main().catch((err) => {
  console.error(`bench-screen: ${String(err)}`);
  process.exit(1);
});
