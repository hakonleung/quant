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

import { DataType, Decimal, type Table } from 'apache-arrow';
import { KlineBarSchema, type KlineBar } from '@quant/shared';

import type { KlineRow } from '../kline.row.js';

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

type ScaleMap = Readonly<Record<string, number>>;

/**
 * Bulk-mapper variant: the `list_kline_bulk_last_n` Arrow table tags
 * every row with its source `code`, so the gateway groups by code in
 * one pass instead of mounting one HTTP request per stock.
 */
export function arrowTableToKlineBarsByCode(table: Table): Record<string, KlineBar[]> {
  const scales = decimalScales(table);
  const out: Record<string, KlineBar[]> = {};
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as RowAccess & { code?: unknown };
    if (typeof row.code !== 'string' || row.code.length === 0) continue;
    const bar = decodeBar(row, scales);
    const list = out[row.code];
    if (list === undefined) {
      out[row.code] = [bar];
    } else {
      list.push(bar);
    }
  }
  return out;
}

function decodeBar(row: RowAccess, scales: ScaleMap): KlineBar {
  const candidate = {
    date: dateToIsoDate(row.trade_date, 'trade_date'),
    open: requireNumber(row.open_qfq, 'open_qfq', scales),
    high: requireNumber(row.high_qfq, 'high_qfq', scales),
    low: requireNumber(row.low_qfq, 'low_qfq', scales),
    close: requireNumber(row.close_qfq, 'close_qfq', scales),
    volume: requireIntegralNumber(row.volume, 'volume'),
    turnover: requireNumber(row.amount, 'amount', scales),
    turnoverRate: requireNumber(row.turnover_rate, 'turnover_rate', scales),
    ma5: optionalNumber(row.ma5, 'ma5', scales),
    ma10: optionalNumber(row.ma10, 'ma10', scales),
    ma20: optionalNumber(row.ma20, 'ma20', scales),
    ma60: optionalNumber(row.ma60, 'ma60', scales),
  };
  return KlineBarSchema.parse(candidate);
}

/**
 * Decode the Arrow table returned by the Python `sync_kline_for_code`
 * Flight op into `KlineRow[]` ready for `KlineWriterService.appendBars`.
 *
 * Schema is the float64-everywhere SYNC_BARS_SCHEMA (matches our
 * `KLINE_COLUMNS`), so no decimal scaling is required — just project.
 */
export function arrowTableToKlineRows(table: Table): KlineRow[] {
  const out: KlineRow[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as Record<string, unknown>;
    const code = row['code'];
    if (typeof code !== 'string' || code.length === 0) continue;
    out.push({
      code,
      ts: tsToDate(row['ts'], 'ts'),
      open_qfq: requirePlainNumber(row['open_qfq'], 'open_qfq'),
      high_qfq: requirePlainNumber(row['high_qfq'], 'high_qfq'),
      low_qfq: requirePlainNumber(row['low_qfq'], 'low_qfq'),
      close_qfq: requirePlainNumber(row['close_qfq'], 'close_qfq'),
      volume: requireIntegralNumber(row['volume'], 'volume'),
      amount: requirePlainNumber(row['amount'], 'amount'),
      turnover_rate: requirePlainNumber(row['turnover_rate'], 'turnover_rate'),
      ma5: optionalPlainNumber(row['ma5']),
      ma10: optionalPlainNumber(row['ma10']),
      ma20: optionalPlainNumber(row['ma20']),
      ma60: optionalPlainNumber(row['ma60']),
    });
  }
  return out;
}

export interface SyncKlineReport {
  readonly code: string;
  readonly mode: string;
  readonly fetchedBars: number;
  readonly writtenBars: number;
  readonly newLastDate: string | null;
}

/**
 * Read the sync metadata (mode / counts / new_last_date) that the Python
 * op attaches to the bars table schema. Missing fields fall back to safe
 * defaults so the worker can still log even on a partial response.
 */
export function readSyncKlineReport(table: Table): SyncKlineReport {
  const md = table.schema.metadata;
  const get = (key: string): string | undefined => {
    if (md === null || md === undefined) return undefined;
    // metadata is a Map<string, string> in apache-arrow JS — `get` accepts
    // the key directly when present.
    const value = (md as Map<string, string> | Record<string, string>);
    if (value instanceof Map) return value.get(key);
    return value[key];
  };
  const newLastDate = get('new_last_date');
  return {
    code: get('code') ?? '',
    mode: get('mode') ?? 'unknown',
    fetchedBars: Number(get('fetched_bars') ?? 0),
    writtenBars: Number(get('written_bars') ?? 0),
    newLastDate: newLastDate !== undefined && newLastDate !== '' ? newLastDate : null,
  };
}

function requirePlainNumber(raw: unknown, field: string): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  throw new Error(`kline.${field}: expected number, got ${describe(raw)}`);
}

function optionalPlainNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'bigint') return Number(raw);
  return null;
}

function tsToDate(raw: unknown, field: string): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return new Date(raw);
  if (typeof raw === 'number') {
    const ms = raw > 1e8 ? raw : raw * 86_400_000;
    return new Date(ms);
  }
  if (typeof raw === 'bigint') return tsToDate(Number(raw), field);
  throw new Error(`kline.${field}: cannot interpret ${describe(raw)} as date`);
}

export function arrowTableToKlineBars(table: Table): KlineBar[] {
  const scales = decimalScales(table);
  const out: KlineBar[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as RowAccess;
    const candidate = {
      date: dateToIsoDate(row.trade_date, 'trade_date'),
      open: requireNumber(row.open_qfq, 'open_qfq', scales),
      high: requireNumber(row.high_qfq, 'high_qfq', scales),
      low: requireNumber(row.low_qfq, 'low_qfq', scales),
      close: requireNumber(row.close_qfq, 'close_qfq', scales),
      volume: requireIntegralNumber(row.volume, 'volume'),
      turnover: requireNumber(row.amount, 'amount', scales),
      turnoverRate: requireNumber(row.turnover_rate, 'turnover_rate', scales),
      ma5: optionalNumber(row.ma5, 'ma5', scales),
      ma10: optionalNumber(row.ma10, 'ma10', scales),
      ma20: optionalNumber(row.ma20, 'ma20', scales),
      ma60: optionalNumber(row.ma60, 'ma60', scales),
    };
    out.push(KlineBarSchema.parse(candidate));
  }
  return out;
}

function decimalScales(table: Table): ScaleMap {
  const scales: Record<string, number> = {};
  for (const field of table.schema.fields) {
    if (DataType.isDecimal(field.type)) {
      scales[field.name] = (field.type as Decimal).scale;
    }
  }
  return scales;
}

function requireNumber(raw: unknown, field: string, scales: ScaleMap): number {
  const n = coerceNumber(raw, scales[field]);
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

function optionalNumber(raw: unknown, field: string, scales: ScaleMap): number | null {
  if (raw === null || raw === undefined) return null;
  return coerceNumber(raw, scales[field]);
}

function coerceNumber(raw: unknown, scale: number | undefined): number | null {
  const divisor = scale && scale > 0 ? Math.pow(10, scale) : 1;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw / divisor : null;
  if (typeof raw === 'bigint') return Number(raw) / divisor;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n / divisor : null;
  }
  // apache-arrow `Decimal128` rows surface as a Uint32Array of four 32-bit
  // little-endian limbs holding the unscaled two's-complement integer. We
  // reconstruct via BigInt arithmetic to preserve sign and 128-bit range,
  // then divide by 10^scale to land back in JS-number territory.
  if (raw instanceof Uint32Array && raw.length === 4) {
    const unscaled = uint32QuadToBigInt(raw);
    return bigIntToScaledNumber(unscaled, divisor);
  }
  if (typeof raw === 'object' && raw !== null && 'toString' in raw) {
    const n = Number(String(raw));
    return Number.isFinite(n) ? n / divisor : null;
  }
  return null;
}

function uint32QuadToBigInt(quad: Uint32Array): bigint {
  // Four little-endian 32-bit limbs → unsigned 128-bit, then re-interpret
  // the top bit as the sign.
  const [a = 0, b = 0, c = 0, d = 0] = quad;
  let unsigned = BigInt(a) | (BigInt(b) << 32n) | (BigInt(c) << 64n) | (BigInt(d) << 96n);
  const SIGN_BIT = 1n << 127n;
  const RANGE = 1n << 128n;
  if (unsigned & SIGN_BIT) unsigned -= RANGE;
  return unsigned;
}

function bigIntToScaledNumber(unscaled: bigint, divisor: number): number {
  if (divisor === 1) return Number(unscaled);
  const negative = unscaled < 0n;
  const abs = negative ? -unscaled : unscaled;
  const scale = BigInt(Math.round(Math.log10(divisor)));
  const factor = 10n ** scale;
  const intPart = abs / factor;
  const fracPart = abs % factor;
  const fracStr = fracPart.toString().padStart(Number(scale), '0');
  const value = Number(`${intPart.toString()}.${fracStr}`);
  return negative ? -value : value;
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
    // apache-arrow's DateDay (date32) `toJSON()` emits milliseconds
    // since epoch (not days). Anything below ~1e8 we treat as days for
    // safety against alternate bindings.
    const ms = raw > 1e8 ? raw : raw * 86_400_000;
    return dateToIsoDate(new Date(ms), field);
  }
  if (typeof raw === 'bigint') {
    return dateToIsoDate(Number(raw), field);
  }
  throw new Error(`kline.${field}: cannot interpret ${describe(raw)} as date`);
}

function describe(raw: unknown): string {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  return typeof raw;
}
