/**
 * NestJS-side writer for ``data/stock_metas.parquet`` metrics columns.
 *
 * Storage-unify-rollout: the previous design had Python's
 * ``upsert_stock_metrics_for_code{,s}`` Flight ops persist the
 * computed metrics block directly to the meta parquet, which left
 * two processes racing on the same file every time a kline-worker
 * job fired. The compute ops now return the projection via Arrow;
 * this service writes it locally so NestJS owns the meta parquet
 * end-to-end on the metrics-column side.
 *
 * Strategy: load the parquet via DuckDB, patch the metrics columns
 * for the incoming code(s) using a single LEFT JOIN against the new
 * rows, COPY the merged table to a sibling tmp file, atomic rename.
 * In-process writes serialise via {@link writeChain}; the meta-sync
 * cron (still in Python for now) is intentionally scheduled
 * disjointly from kline workers so the across-process race window
 * stays empty in practice — see ``docs/perf/storage-unify-rollout.md``.
 *
 * After every successful write the local adapter cache is
 * invalidated so the next read picks up the new metrics block
 * immediately rather than waiting on the 60s SWR window.
 */

import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';

import { CLOCK, type Clock } from '../../common/clock.js';
import { LocalStockMetaAdapter, STOCK_META_DATA_DIR } from './local-stock-meta.adapter.js';

const META_FILE = 'stock_metas.parquet';

const METRIC_DECIMAL_COLUMNS = [
  'metrics_price',
  'ret_1d',
  'ret_5d',
  'ret_10d',
  'ret_20d',
  'ret_90d',
  'ret_250d',
  'mkt_cap',
  'float_mkt_cap',
  'pe_ttm',
  'pe_dynamic',
  'pb',
  'peg',
  'gross_margin_ttm',
] as const;

export type MetricDecimalColumn = (typeof METRIC_DECIMAL_COLUMNS)[number];

export interface StockMetricsRow {
  readonly code: string;
  readonly asof: string | null; // ISO YYYY-MM-DD or null
  readonly metricsPrice: string | null;
  readonly ret_1d: string | null;
  readonly ret_5d: string | null;
  readonly ret_10d: string | null;
  readonly ret_20d: string | null;
  readonly ret_90d: string | null;
  readonly ret_250d: string | null;
  readonly mkt_cap: string | null;
  readonly float_mkt_cap: string | null;
  readonly pe_ttm: string | null;
  readonly pe_dynamic: string | null;
  readonly pb: string | null;
  readonly peg: string | null;
  readonly gross_margin_ttm: string | null;
}

@Injectable()
export class LocalStockMetaWriterService {
  private readonly logger = new Logger(LocalStockMetaWriterService.name);
  private readonly filePath: string;
  private connPromise: Promise<DuckDBConnection> | null = null;
  /** In-process serialisation — every upsert flows through this chain. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    @Inject(STOCK_META_DATA_DIR) dataRoot: string,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LocalStockMetaAdapter) private readonly adapter: LocalStockMetaAdapter,
  ) {
    this.filePath = join(dataRoot, META_FILE);
  }

  /**
   * Patch the metrics columns for ``rows`` and rewrite the parquet.
   *
   * Rows whose ``code`` is not already present in the meta parquet are
   * silently dropped — matches the Python compute handler, which only
   * returns rows it found a meta record for.
   *
   * No-op when ``rows`` is empty.
   */
  async upsertMetrics(rows: readonly StockMetricsRow[]): Promise<void> {
    if (rows.length === 0) return;
    const next = this.writeChain.then(
      () => this.runUpsert(rows),
      () => this.runUpsert(rows),
    );
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  private async runUpsert(rows: readonly StockMetricsRow[]): Promise<void> {
    if (!(await fileExists(this.filePath))) {
      this.logger.warn(
        `stock_metas.parquet missing at ${this.filePath}; skipping metrics upsert for ${rows.length} row(s)`,
      );
      return;
    }
    const conn = await this.connection();
    const updatedAt = this.clock.now();
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await conn.run(this.buildCopySql(rows, tmp, updatedAt));
      await rename(tmp, this.filePath);
      this.adapter.invalidate();
      this.logger.log(`stock_metrics_upsert wrote=${rows.length}`);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private buildCopySql(
    rows: readonly StockMetricsRow[],
    tmpPath: string,
    updatedAt: Date,
  ): string {
    const valuesSql = rows.map((r) => this.rowToValues(r)).join(',\n        ');
    // Column list for the new-metrics CTE must exactly match `rowToValues`
    // order so DuckDB binds positionally.
    const newCols = [
      'code',
      'metrics_asof',
      ...METRIC_DECIMAL_COLUMNS,
    ];
    const newColList = newCols.map(quoteIdent).join(', ');
    // Build the SELECT that rewrites the parquet: keep every preserved
    // column verbatim; replace each metrics_* column with the new value
    // when the code matches `n`, otherwise fall back to the old value.
    const updatedAtSql = `TIMESTAMP '${updatedAt.toISOString().replace('T', ' ').replace('Z', '')}'`;
    const preserved = [
      'code',
      'name',
      'name_pinyin',
      'industries',
      'list_date',
      'float_pct',
      'updated_at',
      'total_share',
      'float_share',
      'net_assets',
      'net_assets_period',
      'quarterlies_json',
      'financials_updated_at',
    ];
    const preservedSql = preserved.map((c) => `o.${quoteIdent(c)}`).join(', ');
    const overlaySql = [
      `CASE WHEN n.code IS NOT NULL THEN n.metrics_asof ELSE o.metrics_asof END AS metrics_asof`,
      `CASE WHEN n.code IS NOT NULL THEN ${updatedAtSql} ELSE o.metrics_updated_at END AS metrics_updated_at`,
      ...METRIC_DECIMAL_COLUMNS.map(
        (col) =>
          `CASE WHEN n.code IS NOT NULL THEN n.${quoteIdent(col)} ELSE o.${quoteIdent(col)} END AS ${quoteIdent(col)}`,
      ),
    ].join(',\n      ');
    return `
      COPY (
        WITH new_metrics(${newColList}) AS (
          SELECT * FROM (VALUES
        ${valuesSql}
          ) AS t(${newColList})
        )
        SELECT
          ${preservedSql},
          ${overlaySql}
        FROM read_parquet(${quoteLiteral(this.filePath)}) AS o
        LEFT JOIN new_metrics AS n ON n.code = o.code
      ) TO ${quoteLiteral(tmpPath)} (FORMAT PARQUET);
    `;
  }

  private rowToValues(row: StockMetricsRow): string {
    // Column order must match `newCols` in buildCopySql.
    const parts: string[] = [
      quoteLiteral(row.code),
      row.asof === null ? 'CAST(NULL AS DATE)' : `DATE '${row.asof}'`,
      quoteOptionalString(row.metricsPrice),
      quoteOptionalString(row.ret_1d),
      quoteOptionalString(row.ret_5d),
      quoteOptionalString(row.ret_10d),
      quoteOptionalString(row.ret_20d),
      quoteOptionalString(row.ret_90d),
      quoteOptionalString(row.ret_250d),
      quoteOptionalString(row.mkt_cap),
      quoteOptionalString(row.float_mkt_cap),
      quoteOptionalString(row.pe_ttm),
      quoteOptionalString(row.pe_dynamic),
      quoteOptionalString(row.pb),
      quoteOptionalString(row.peg),
      quoteOptionalString(row.gross_margin_ttm),
    ];
    return `(${parts.join(', ')})`;
  }

  private connection(): Promise<DuckDBConnection> {
    if (this.connPromise === null) {
      this.connPromise = (async () => {
        const inst = await DuckDBInstance.create(':memory:');
        return inst.connect();
      })();
    }
    return this.connPromise;
  }
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function quoteOptionalString(v: string | null): string {
  if (v === null) return 'CAST(NULL AS VARCHAR)';
  return `'${v.replace(/'/g, "''")}'`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
