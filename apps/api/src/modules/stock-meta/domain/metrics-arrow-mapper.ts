/**
 * Decode the Arrow table produced by the Python
 * ``compute_stock_metrics_for_code{,s}`` Flight ops into the
 * {@link StockMetricsRow} shape consumed by
 * {@link LocalStockMetaWriterService}.
 *
 * Column types per ``COMPUTE_METRICS_SCHEMA`` (services/py/quant_rpc/
 * ops/stock_metrics.py):
 *   - ``code``           : string (required)
 *   - ``asof``           : date32, nullable
 *   - all metric columns : string, nullable (decimal-as-string)
 */

import type { Table } from 'apache-arrow';

import type { StockMetricsRow } from '../local-stock-meta-writer.service.js';

export function arrowTableToStockMetricsRows(table: Table): StockMetricsRow[] {
  const out: StockMetricsRow[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as Record<string, unknown>;
    const code = row['code'];
    if (typeof code !== 'string' || code.length === 0) continue;
    out.push({
      code,
      asof: optionalIsoDate(row['asof']),
      metricsPrice: optionalString(row['metrics_price']),
      ret_1d: optionalString(row['ret_1d']),
      ret_5d: optionalString(row['ret_5d']),
      ret_10d: optionalString(row['ret_10d']),
      ret_20d: optionalString(row['ret_20d']),
      ret_90d: optionalString(row['ret_90d']),
      ret_250d: optionalString(row['ret_250d']),
      mkt_cap: optionalString(row['mkt_cap']),
      float_mkt_cap: optionalString(row['float_mkt_cap']),
      pe_ttm: optionalString(row['pe_ttm']),
      pe_dynamic: optionalString(row['pe_dynamic']),
      pb: optionalString(row['pb']),
      peg: optionalString(row['peg']),
      gross_margin_ttm: optionalString(row['gross_margin_ttm']),
    });
  }
  return out;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(
    `stock-metrics arrow: optional decimal must be string-like, got ${typeof value}`,
  );
}

function optionalIsoDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const d = coerceDate(value);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function coerceDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'bigint') return new Date(Number(value));
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj['micros'] === 'bigint') return new Date(Number(obj['micros']) / 1000);
    if (typeof obj['days'] === 'number') return new Date(obj['days'] * 86_400_000);
  }
  throw new Error(`stock-metrics arrow: asof must be Date-like, got ${typeof value}`);
}
