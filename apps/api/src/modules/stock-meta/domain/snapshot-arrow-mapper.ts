/**
 * Decode an Arrow `Table` produced by the Python `list_stock_snapshots`
 * Flight op into the strict `StockSnapshotDto` shape.
 *
 * The snapshot schema is the meta schema + (price, asof, 7 derived
 * decimal columns); the meta portion is delegated back to
 * {@link arrowTableToStockMetaDtos} via per-row recomposition so the
 * meta validation rules stay single-sourced.
 */

import type { Table } from 'apache-arrow';
import {
  QuarterlyFinancialsSchema,
  StockSnapshotDtoSchema,
  type QuarterlyFinancials,
  type StockMetaDto,
  type StockSnapshotDto,
} from '@quant/shared';

interface RowAccess {
  // meta fields
  readonly code: unknown;
  readonly name: unknown;
  readonly name_pinyin: unknown;
  readonly industries: unknown;
  readonly list_date: unknown;
  readonly float_pct: unknown;
  readonly updated_at: unknown;
  readonly total_share?: unknown;
  readonly float_share?: unknown;
  readonly net_assets?: unknown;
  readonly net_assets_period?: unknown;
  readonly quarterlies_json?: unknown;
  readonly financials_updated_at?: unknown;
  // snapshot fields
  readonly price?: unknown;
  readonly asof?: unknown;
  readonly mkt_cap?: unknown;
  readonly float_mkt_cap?: unknown;
  readonly pe_ttm?: unknown;
  readonly pe_dynamic?: unknown;
  readonly pb?: unknown;
  readonly peg?: unknown;
  readonly gross_margin_ttm?: unknown;
}

export function arrowTableToStockSnapshotDtos(table: Table): StockSnapshotDto[] {
  const out: StockSnapshotDto[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as RowAccess;
    const meta: StockMetaDto = {
      code: requireString(row.code, 'code'),
      name: requireString(row.name, 'name'),
      name_pinyin: requireString(row.name_pinyin, 'name_pinyin'),
      industries: requireString(row.industries, 'industries'),
      list_date: dateToIsoDate(row.list_date, 'list_date'),
      float_pct: requireString(row.float_pct, 'float_pct'),
      updated_at: dateToIsoUtc(row.updated_at, 'updated_at'),
      total_share: optionalString(row.total_share),
      float_share: optionalString(row.float_share),
      net_assets: optionalString(row.net_assets),
      net_assets_period: optionalIsoDate(row.net_assets_period),
      quarterlies: parseQuarterlies(row.quarterlies_json),
      financials_updated_at: optionalIsoUtc(row.financials_updated_at),
    };
    const candidate = {
      meta,
      price: optionalString(row.price),
      asof: optionalIsoDate(row.asof),
      derived: {
        mkt_cap: optionalString(row.mkt_cap),
        float_mkt_cap: optionalString(row.float_mkt_cap),
        pe_ttm: optionalString(row.pe_ttm),
        pe_dynamic: optionalString(row.pe_dynamic),
        pb: optionalString(row.pb),
        peg: optionalString(row.peg),
        gross_margin_ttm: optionalString(row.gross_margin_ttm),
      },
    };
    out.push(StockSnapshotDtoSchema.parse(candidate));
  }
  return out;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`stock-snapshot arrow: ${field} must be string, got ${typeof value}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(
    `stock-snapshot arrow: optional decimal must be string-like, got ${typeof value}`,
  );
}

function optionalIsoDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return dateToIsoDate(value, 'optional date');
}

function optionalIsoUtc(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return dateToIsoUtc(value, 'optional datetime');
}

function dateToIsoDate(value: unknown, field: string): string {
  const d = coerceDate(value, field);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateToIsoUtc(value: unknown, field: string): string {
  const d = coerceDate(value, field);
  return d.toISOString().replace(/Z$/, '+00:00');
}

function coerceDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'bigint') return new Date(Number(value));
  throw new Error(`stock-snapshot arrow: ${field} must be Date-like, got ${typeof value}`);
}

function parseQuarterlies(value: unknown): QuarterlyFinancials[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') {
    throw new Error(
      `stock-snapshot arrow: quarterlies_json must be string, got ${typeof value}`,
    );
  }
  const raw: unknown = JSON.parse(value);
  if (!Array.isArray(raw)) {
    throw new Error('stock-snapshot arrow: quarterlies_json must be a JSON array');
  }
  const out: QuarterlyFinancials[] = [];
  for (const entry of raw) out.push(QuarterlyFinancialsSchema.parse(entry));
  return out;
}
