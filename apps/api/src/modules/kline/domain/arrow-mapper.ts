/**
 * Decode an Arrow `Table` produced by ``list_kline_for_code`` into the
 * shared ``KlineBar`` shape consumed by the BFF / frontend.
 *
 * Front-adjusted prices (``*_qfq``) are surfaced as the canonical
 * OHLC because the chart needs a continuous series across splits /
 * dividends. The ``ma{5,10,20,60}`` columns are likewise the
 * pre-computed front-adjusted moving averages from the kline writer.
 *
 * Arrow ``decimal128`` values arrive as opaque objects; we convert via
 * `toString()` and `Number(...)` because (a) the precision we lose on
 * a JS number (15 sig-digits) is well above any A-share price's needed
 * resolution, and (b) the alternative — propagating Decimal across the
 * BFF — bloats the cross-process contract for no UI benefit.
 */

import type { Table } from 'apache-arrow';
import { KlineBarSchema, type KlineBar } from '@quant/shared';

interface RowAccess {
  readonly trade_date: unknown;
  readonly volume: unknown;
  readonly amount: unknown;
  readonly turnover_rate: unknown;
  readonly open_qfq: unknown;
  readonly high_qfq: unknown;
  readonly low_qfq: unknown;
  readonly close_qfq: unknown;
  readonly ma5: unknown;
  readonly ma10: unknown;
  readonly ma20: unknown;
  readonly ma60: unknown;
}

export function arrowTableToKlineBars(table: Table): KlineBar[] {
  const out: KlineBar[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as RowAccess;
    const candidate = {
      date: dateToIsoDate(row.trade_date, 'trade_date'),
      open: requireNumber(row.open_qfq, 'open_qfq'),
      high: requireNumber(row.high_qfq, 'high_qfq'),
      low: requireNumber(row.low_qfq, 'low_qfq'),
      close: requireNumber(row.close_qfq, 'close_qfq'),
      volume: requireIntegralNumber(row.volume, 'volume'),
      turnover: requireNumber(row.amount, 'amount'),
      turnoverRate: requireNumber(row.turnover_rate, 'turnover_rate'),
      ma5: optionalNumber(row.ma5),
      ma10: optionalNumber(row.ma10),
      ma20: optionalNumber(row.ma20),
      ma60: optionalNumber(row.ma60),
    };
    out.push(KlineBarSchema.parse(candidate));
  }
  return out;
}

function requireNumber(raw: unknown, field: string): number {
  const n = coerceNumber(raw);
  if (n === null) {
    throw new Error(`kline.${field}: expected numeric, got ${describe(raw)}`);
  }
  return n;
}

function requireIntegralNumber(raw: unknown, field: string): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`kline.${field}: expected integral, got ${describe(raw)}`);
}

function optionalNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  return coerceNumber(raw);
}

function coerceNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  // Arrow `Decimal128` exposes a `.toString()` that returns the decimal
  // representation; we go through the string path to avoid platform
  // differences in numeric coercion.
  if (typeof raw === 'object' && raw !== null && 'toString' in raw) {
    const s = String(raw);
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function dateToIsoDate(raw: unknown, field: string): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  if (raw instanceof Date) {
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return `${String(y)}-${m}-${d}`;
  }
  if (typeof raw === 'number') {
    // Arrow date32 → days since epoch.
    const dt = new Date(raw * 86_400_000);
    return dateToIsoDate(dt, field);
  }
  throw new Error(`kline.${field}: cannot interpret ${describe(raw)} as date`);
}

function describe(raw: unknown): string {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  return typeof raw;
}
