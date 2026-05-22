/**
 * NestJS-side writer for ``data/stock_metas.parquet``.
 *
 * Storage-unify-rollout: every parquet write now flows through this
 * service. Two upsert paths:
 *
 *   - {@link upsertMetrics} — patches the ``metrics_*`` block produced
 *     by the post-kline projector (``compute_stock_metrics_for_code``).
 *   - {@link upsertMetas} — patches the non-metric (meta) columns
 *     produced by the meta-sync / financials Flight ops. Existing
 *     ``metrics_*`` columns on matched rows are preserved verbatim
 *     so a financials cron tick never wipes the snapshot block.
 *
 * Both paths use the same in-process serialisation chain
 * ({@link writeChain}) — they share the parquet file, so a metrics
 * patch and a meta upsert cannot race their read-modify-write cycles.
 *
 * Strategy for each path: load the parquet via DuckDB, overlay the
 * incoming rows via a CTE + JOIN, COPY the merged table to a sibling
 * tmp file, atomic rename. After every successful write the local
 * adapter cache is invalidated so the next read picks up the new
 * rows immediately rather than waiting on the 60s SWR window.
 */

import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';
import type { QuarterlyFinancials, StockMetaDto } from '@quant/shared';

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
  // `wcmi` — wave-quality composite ∈ [0, 1000] (see
  // `docs/perf/wcmi-redesign.md`). The seven `wcmi_*` columns are the
  // per-sub-score cross-sectional percentiles × 100 used both for FE
  // breakdown rendering and for tuning the composite weights.
  'wcmi',
  'wcmi_rhythm',
  'wcmi_ma_support',
  'wcmi_up_wave',
  'wcmi_yang_dom',
  'wcmi_shadow_clean',
  'wcmi_stage_gain',
  'wcmi_crash_avoid',
  'wcmi_recent_strength',
] as const;

export type MetricDecimalColumn = (typeof METRIC_DECIMAL_COLUMNS)[number];

const DDE_DECIMAL_COLUMNS = [
  'dde_main_net_inflow_3d',
  'dde_main_net_inflow_5d',
  'dde_main_net_inflow_10d',
  'dde_main_net_inflow_20d',
  'dde_main_inflow_ratio_3d',
  'dde_main_inflow_ratio_5d',
  'dde_main_inflow_ratio_10d',
  'dde_main_inflow_ratio_20d',
] as const;

export type DdeDecimalColumn = (typeof DDE_DECIMAL_COLUMNS)[number];

export interface StockFundFlowRow {
  readonly code: string;
  readonly dde_main_net_inflow_3d: string | null;
  readonly dde_main_net_inflow_5d: string | null;
  readonly dde_main_net_inflow_10d: string | null;
  readonly dde_main_net_inflow_20d: string | null;
  readonly dde_main_inflow_ratio_3d: string | null;
  readonly dde_main_inflow_ratio_5d: string | null;
  readonly dde_main_inflow_ratio_10d: string | null;
  readonly dde_main_inflow_ratio_20d: string | null;
}

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
  readonly wcmi: string | null;
  readonly wcmi_rhythm: string | null;
  readonly wcmi_ma_support: string | null;
  readonly wcmi_up_wave: string | null;
  readonly wcmi_yang_dom: string | null;
  readonly wcmi_shadow_clean: string | null;
  readonly wcmi_stage_gain: string | null;
  readonly wcmi_crash_avoid: string | null;
  readonly wcmi_recent_strength: string | null;
}

@Injectable()
export class LocalStockMetaWriterService {
  private readonly logger = new Logger(LocalStockMetaWriterService.name);
  private readonly filePath: string;
  private connPromise: Promise<DuckDBConnection> | null = null;
  /** In-process serialisation — every upsert flows through this chain. */
  private writeChain: Promise<void> = Promise.resolve();
  /** One-shot per-process backfill of any missing metric/DDE columns
   *  on a legacy parquet file. Resolves once the file's column set
   *  covers everything the writer expects. */
  private schemaMigrated: Promise<void> | null = null;

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
      () => this.runUpsertMetrics(rows),
      () => this.runUpsertMetrics(rows),
    );
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  /**
   * Patch the non-metric (meta) columns for ``rows``: existing codes
   * have their meta block replaced verbatim; new codes are inserted
   * with NULL ``metrics_*`` columns. Existing codes' ``metrics_*``
   * columns are passed through unchanged so a meta-side write never
   * stomps the snapshot block the kline-worker projector wrote.
   *
   * No-op when ``rows`` is empty.
   */
  async upsertMetas(rows: readonly StockMetaDto[]): Promise<void> {
    if (rows.length === 0) return;
    const next = this.writeChain.then(
      () => this.runUpsertMetas(rows),
      () => this.runUpsertMetas(rows),
    );
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  /**
   * Patch the DDE 主力 fund-flow columns for ``rows``. Existing
   * ``dde_*`` columns on matched rows are replaced; codes not in the
   * meta parquet are silently dropped (the akshare rank endpoint
   * sometimes carries codes that aren't in our listed-stock universe,
   * e.g. ST/退市 stocks). Non-matched rows in the parquet keep their
   * prior ``dde_*`` values verbatim — a single window failure on the
   * upstream side cannot wipe yesterday's full block.
   *
   * No-op when ``rows`` is empty.
   */
  async upsertFundFlow(rows: readonly StockFundFlowRow[]): Promise<void> {
    if (rows.length === 0) return;
    const next = this.writeChain.then(
      () => this.runUpsertFundFlow(rows),
      () => this.runUpsertFundFlow(rows),
    );
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  private async runUpsertMetrics(rows: readonly StockMetricsRow[]): Promise<void> {
    if (!(await fileExists(this.filePath))) {
      this.logger.warn(
        `stock_metas.parquet missing at ${this.filePath}; skipping metrics upsert for ${rows.length} row(s)`,
      );
      return;
    }
    await this.ensureSchema();
    const conn = await this.connection();
    const updatedAt = this.clock.now();
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await conn.run(this.buildMetricsCopySql(rows, tmp, updatedAt));
      await rename(tmp, this.filePath);
      this.adapter.invalidate();
      this.logger.log(`stock_metrics_upsert wrote=${rows.length}`);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async runUpsertFundFlow(rows: readonly StockFundFlowRow[]): Promise<void> {
    if (!(await fileExists(this.filePath))) {
      this.logger.warn(
        `stock_metas.parquet missing at ${this.filePath}; skipping fund-flow upsert for ${rows.length} row(s)`,
      );
      return;
    }
    await this.ensureSchema();
    const conn = await this.connection();
    const updatedAt = this.clock.now();
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await conn.run(this.buildFundFlowCopySql(rows, tmp, updatedAt));
      await rename(tmp, this.filePath);
      this.adapter.invalidate();
      this.logger.log(`stock_fund_flow_upsert wrote=${rows.length}`);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async runUpsertMetas(rows: readonly StockMetaDto[]): Promise<void> {
    if (!(await fileExists(this.filePath))) {
      this.logger.warn(
        `stock_metas.parquet missing at ${this.filePath}; skipping meta upsert for ${rows.length} row(s)`,
      );
      return;
    }
    await this.ensureSchema();
    const conn = await this.connection();
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await conn.run(this.buildMetasCopySql(rows, tmp));
      await rename(tmp, this.filePath);
      this.adapter.invalidate();
      this.logger.log(`stock_meta_upsert wrote=${rows.length}`);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private buildFundFlowCopySql(
    rows: readonly StockFundFlowRow[],
    tmpPath: string,
    updatedAt: Date,
  ): string {
    const newCols = ['code', ...DDE_DECIMAL_COLUMNS];
    const newColList = newCols.map(quoteIdent).join(', ');
    const valuesSql = rows.map((r) => this.fundFlowRowToValues(r)).join(',\n        ');
    const updatedAtSql = `TIMESTAMP '${updatedAt.toISOString().replace('T', ' ').replace('Z', '')}'`;
    // Every non-DDE column passes through verbatim from the existing row.
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
      'metrics_asof',
      'metrics_updated_at',
      ...METRIC_DECIMAL_COLUMNS,
    ];
    const preservedSql = preserved.map((c) => `o.${quoteIdent(c)}`).join(', ');
    const overlaySql = [
      ...DDE_DECIMAL_COLUMNS.map(
        (col) =>
          `CASE WHEN n.code IS NOT NULL THEN n.${quoteIdent(col)} ELSE o.${quoteIdent(col)} END AS ${quoteIdent(col)}`,
      ),
      `CASE WHEN n.code IS NOT NULL THEN ${updatedAtSql} ELSE o.dde_updated_at END AS dde_updated_at`,
    ].join(',\n      ');
    return `
      COPY (
        WITH new_dde(${newColList}) AS (
          SELECT * FROM (VALUES
        ${valuesSql}
          ) AS t(${newColList})
        )
        SELECT
          ${preservedSql},
          ${overlaySql}
        FROM read_parquet(${quoteLiteral(this.filePath)}) AS o
        LEFT JOIN new_dde AS n ON n.code = o.code
      ) TO ${quoteLiteral(tmpPath)} (FORMAT PARQUET);
    `;
  }

  private fundFlowRowToValues(row: StockFundFlowRow): string {
    return `(${[
      quoteLiteral(row.code),
      quoteOptionalString(row.dde_main_net_inflow_3d),
      quoteOptionalString(row.dde_main_net_inflow_5d),
      quoteOptionalString(row.dde_main_net_inflow_10d),
      quoteOptionalString(row.dde_main_net_inflow_20d),
      quoteOptionalString(row.dde_main_inflow_ratio_3d),
      quoteOptionalString(row.dde_main_inflow_ratio_5d),
      quoteOptionalString(row.dde_main_inflow_ratio_10d),
      quoteOptionalString(row.dde_main_inflow_ratio_20d),
    ].join(', ')})`;
  }

  private buildMetricsCopySql(
    rows: readonly StockMetricsRow[],
    tmpPath: string,
    updatedAt: Date,
  ): string {
    const valuesSql = rows.map((r) => this.rowToValues(r)).join(',\n        ');
    // Column list for the new-metrics CTE must exactly match `rowToValues`
    // order so DuckDB binds positionally.
    const newCols = ['code', 'metrics_asof', ...METRIC_DECIMAL_COLUMNS];
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
      // DDE block is preserved across a metrics-side write so the
      // ratio columns don't get wiped between fund-flow refreshes.
      ...DDE_DECIMAL_COLUMNS,
      'dde_updated_at',
    ];
    const preservedSql = preserved.map((c) => `o.${quoteIdent(c)}`).join(', ');
    // For each metric column: prefer the new value when present, fall
    // back to the old. COALESCE rather than CASE-on-`n.code` so a
    // per-code projection that legitimately cannot compute a column
    // (e.g. kline-worker has no universe-rank tables for `wcmi`/
    // `wcmi_*`) doesn't WIPE the column the batch backfill already
    // wrote. Callers that intend to clear a column must do so via a
    // dedicated path, not by passing null in a partial-update row.
    const overlaySql = [
      `COALESCE(n.metrics_asof, o.metrics_asof) AS metrics_asof`,
      // metrics_updated_at only advances when a new row was supplied;
      // otherwise keep whatever timestamp was on disk.
      `CASE WHEN n.code IS NOT NULL THEN ${updatedAtSql} ELSE o.metrics_updated_at END AS metrics_updated_at`,
      ...METRIC_DECIMAL_COLUMNS.map(
        (col) => `COALESCE(n.${quoteIdent(col)}, o.${quoteIdent(col)}) AS ${quoteIdent(col)}`,
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

  private buildMetasCopySql(rows: readonly StockMetaDto[], tmpPath: string): string {
    const newCols = [
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
    const newColList = newCols.map(quoteIdent).join(', ');
    const valuesSql = rows.map((r) => this.metaRowToValues(r)).join(',\n        ');
    // Existing-row → CASE picks new-side when n matched, else old-side.
    // Inserted row → o is NULL for everything, including metric columns
    // (DuckDB FULL OUTER JOIN), so those land NULL automatically.
    const selectMeta = newCols
      .map(
        (c) =>
          `CASE WHEN n.code IS NOT NULL THEN n.${quoteIdent(c)} ELSE o.${quoteIdent(c)} END AS ${quoteIdent(c)}`,
      )
      .join(',\n      ');
    const preservedMetrics = [
      'metrics_asof',
      'metrics_updated_at',
      ...METRIC_DECIMAL_COLUMNS,
      ...DDE_DECIMAL_COLUMNS,
      'dde_updated_at',
    ]
      .map((c) => `o.${quoteIdent(c)} AS ${quoteIdent(c)}`)
      .join(', ');
    return `
      COPY (
        WITH new_metas(${newColList}) AS (
          SELECT * FROM (VALUES
        ${valuesSql}
          ) AS t(${newColList})
        )
        SELECT
          ${selectMeta},
          ${preservedMetrics}
        FROM new_metas AS n
        FULL OUTER JOIN read_parquet(${quoteLiteral(this.filePath)}) AS o
          ON o.code = n.code
      ) TO ${quoteLiteral(tmpPath)} (FORMAT PARQUET);
    `;
  }

  private metaRowToValues(row: StockMetaDto): string {
    const parts: string[] = [
      quoteLiteral(row.code),
      quoteLiteral(row.name),
      quoteLiteral(row.name_pinyin),
      quoteLiteral(row.industries),
      `DATE '${row.list_date}'`,
      quoteLiteral(row.float_pct),
      `TIMESTAMP '${isoToDuckDbTimestamp(row.updated_at)}'`,
      quoteOptionalString(row.total_share),
      quoteOptionalString(row.float_share),
      quoteOptionalString(row.net_assets),
      row.net_assets_period === null ? 'CAST(NULL AS DATE)' : `DATE '${row.net_assets_period}'`,
      quoteQuarterliesJson(row.quarterlies),
      row.financials_updated_at === null
        ? 'CAST(NULL AS TIMESTAMP)'
        : `TIMESTAMP '${isoToDuckDbTimestamp(row.financials_updated_at)}'`,
    ];
    return `(${parts.join(', ')})`;
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
      quoteOptionalString(row.wcmi),
      quoteOptionalString(row.wcmi_rhythm),
      quoteOptionalString(row.wcmi_ma_support),
      quoteOptionalString(row.wcmi_up_wave),
      quoteOptionalString(row.wcmi_yang_dom),
      quoteOptionalString(row.wcmi_shadow_clean),
      quoteOptionalString(row.wcmi_stage_gain),
      quoteOptionalString(row.wcmi_crash_avoid),
      quoteOptionalString(row.wcmi_recent_strength),
    ];
    return `(${parts.join(', ')})`;
  }

  /**
   * Once per process, rewrite the parquet to add any METRIC/DDE
   * columns that the writer expects but the on-disk schema is missing.
   * Lets us evolve the metric set (e.g. adding `wcmi`) without an
   * out-of-band migration script.
   */
  private async ensureSchema(): Promise<void> {
    if (this.schemaMigrated !== null) return this.schemaMigrated;
    this.schemaMigrated = this.runEnsureSchema();
    try {
      await this.schemaMigrated;
    } catch (err) {
      // Reset so a transient failure can be retried by the next caller.
      this.schemaMigrated = null;
      throw err;
    }
  }

  private async runEnsureSchema(): Promise<void> {
    const conn = await this.connection();
    const describeSql = `DESCRIBE SELECT * FROM read_parquet(${quoteLiteral(this.filePath)});`;
    const result = await conn.runAndReadAll(describeSql);
    const present = new Set<string>();
    for (const row of result.getRowObjects() as readonly Record<string, unknown>[]) {
      const name = row['column_name'];
      if (typeof name === 'string') present.add(name);
    }
    const expected: readonly string[] = [...METRIC_DECIMAL_COLUMNS, ...DDE_DECIMAL_COLUMNS];
    const missing = expected.filter((c) => !present.has(c));
    if (missing.length === 0) return;
    const tmp = `${this.filePath}.tmp-schema-${process.pid}-${Date.now()}`;
    const addList = missing.map((c) => `CAST(NULL AS VARCHAR) AS ${quoteIdent(c)}`).join(', ');
    const sql = `COPY (SELECT *, ${addList} FROM read_parquet(${quoteLiteral(this.filePath)})) TO ${quoteLiteral(tmp)} (FORMAT PARQUET);`;
    try {
      await conn.run(sql);
      await rename(tmp, this.filePath);
      this.adapter.invalidate();
      this.logger.log(`stock_metas_schema_migrated added=${missing.join(',')}`);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
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

function quoteQuarterliesJson(quarterlies: readonly QuarterlyFinancials[]): string {
  if (quarterlies.length === 0) return 'CAST(NULL AS VARCHAR)';
  // Mirror Python's `_quarterlies_to_json` shape exactly so the round-trip
  // through `LocalStockMetaAdapter` produces the same `quarterlies` array.
  const compact = quarterlies.map((q) => ({
    period: q.period,
    revenue: q.revenue,
    operating_cost: q.operating_cost,
    net_profit: q.net_profit,
    net_profit_excl_nr: q.net_profit_excl_nr,
  }));
  const json = JSON.stringify(compact);
  return `'${json.replace(/'/g, "''")}'`;
}

function isoToDuckDbTimestamp(iso: string): string {
  // ISO 8601 with offset (e.g. "2026-05-01T00:00:00+00:00") → DuckDB
  // TIMESTAMP literal in plain "YYYY-MM-DD HH:MM:SS[.fff]" form. The
  // meta parquet stores TIMESTAMP(us, UTC); shifting offset to UTC
  // first keeps the column consistent with what Python wrote.
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
