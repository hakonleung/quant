/**
 * Decode an Arrow `Table` produced by the Python Flight server into the
 * strict `StockMetaDto` shape the HTTP API exposes. The mapper is
 * deliberately verbose — every column is named, narrowed, and pushed
 * through the Zod schema — so a contract drift between Python and TS
 * fails loudly here rather than at the consumer.
 *
 * Pure module: no IO, no Nest dependencies. Exported for direct unit
 * testing and reuse by future per-row consumers (e.g. SSE streams).
 */

import type { Table } from 'apache-arrow';
import { StockMetaDtoSchema, type StockMetaDto } from '@quant/shared';

interface RowAccess {
  readonly code: unknown;
  readonly name: unknown;
  readonly name_pinyin: unknown;
  readonly industries: unknown;
  readonly list_date: unknown;
  readonly float_pct: unknown;
  readonly updated_at: unknown;
}

export function arrowTableToStockMetaDtos(table: Table): StockMetaDto[] {
  const out: StockMetaDto[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as RowAccess;
    const candidate = {
      code: requireString(row.code, 'code'),
      name: requireString(row.name, 'name'),
      name_pinyin: requireString(row.name_pinyin, 'name_pinyin'),
      industries: requireString(row.industries, 'industries'),
      list_date: dateToIsoDate(row.list_date, 'list_date'),
      float_pct: requireString(row.float_pct, 'float_pct'),
      updated_at: dateToIsoUtc(row.updated_at, 'updated_at'),
    };
    out.push(StockMetaDtoSchema.parse(candidate));
  }
  return out;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`stock-meta arrow: ${field} must be string, got ${typeof value}`);
  }
  return value;
}

/**
 * Format an Arrow date32 cell as `YYYY-MM-DD` in UTC. Apache Arrow JS
 * returns `Date` for date32 columns; underlying storage is days-since-epoch
 * so the timezone is meaningless — we fix on UTC to avoid surprise.
 */
function dateToIsoDate(value: unknown, field: string): string {
  const d = coerceDate(value, field);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateToIsoUtc(value: unknown, field: string): string {
  const d = coerceDate(value, field);
  // toISOString → "YYYY-MM-DDTHH:mm:ss.sssZ"; rewrite trailing Z as +00:00 so
  // the StockMetaDto regex (which requires an explicit offset) accepts it.
  return d.toISOString().replace(/Z$/, '+00:00');
}

function coerceDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  // apache-arrow occasionally returns the underlying numeric for narrow types;
  // accept it as ms-since-epoch only as a fallback so we stay forgiving across
  // arrow-js versions.
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'bigint') return new Date(Number(value));
  throw new Error(`stock-meta arrow: ${field} must be Date-like, got ${typeof value}`);
}
