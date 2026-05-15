/**
 * Decode the Arrow table produced by the Python ``sync_kline_for_code``
 * Flight op into the typed shapes the orchestrator consumes:
 *
 * * ``arrowTableToKlineRows`` — bars in ``KLINE_COLUMNS`` shape, ready
 *   for ``KlineWriterService.appendBars``.
 * * ``readSyncKlineReport`` — the per-sync metadata (mode / counts /
 *   ``new_last_date``) ridden along as Arrow schema metadata.
 *
 * The legacy decimal-aware decoders that lived here (used by the now
 * retired ``list_kline_for_code`` / ``list_kline_bulk_last_n`` reads)
 * are gone — NestJS reads kline locally via
 * ``KlineReaderService`` which never sees a decimal in transit.
 */

import { type Table } from 'apache-arrow';

import type { KlineRow } from '../kline.row.js';

/**
 * Project the float64-schema bars table into `KlineRow[]` for the
 * writer. No decimal scaling — the schema is already float64.
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
    if (md instanceof Map) return md.get(key);
    return (md as Record<string, string>)[key];
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

function requireIntegralNumber(raw: unknown, field: string): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`kline.${field}: expected integral, got ${describe(raw)}`);
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

function describe(raw: unknown): string {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  return typeof raw;
}
