/**
 * Row shape persisted in the NestJS-side kline time-series store.
 *
 * Mirrors the Arrow schema produced by the Python `list_kline_for_code`
 * Flight op so we can append batches arriving from Python without an
 * intermediate translation step. Plain JS `number` for the OHLC qfq
 * prices is consistent with `KlineBarSchema` in `@quant/shared` — the
 * BFF / FE never needed decimal precision, and the per-row magnitudes
 * stay well inside JS-number territory.
 */

import type { RecordColumnSpec } from '../../common/storage/ports/record-store.port.js';

export interface KlineRow {
  readonly code: string;
  /** Trade date as JS `Date` (UTC midnight); DuckDB DATE column. */
  readonly ts: Date;
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

export const KLINE_COLUMNS: readonly RecordColumnSpec[] = [
  { name: 'code', type: 'VARCHAR', nullable: false },
  { name: 'ts', type: 'DATE', nullable: false },
  { name: 'open_qfq', type: 'DOUBLE' },
  { name: 'high_qfq', type: 'DOUBLE' },
  { name: 'low_qfq', type: 'DOUBLE' },
  { name: 'close_qfq', type: 'DOUBLE' },
  { name: 'volume', type: 'BIGINT' },
  { name: 'amount', type: 'DOUBLE' },
  { name: 'turnover_rate', type: 'DOUBLE' },
  { name: 'ma5', type: 'DOUBLE' },
  { name: 'ma10', type: 'DOUBLE' },
  { name: 'ma20', type: 'DOUBLE' },
  { name: 'ma60', type: 'DOUBLE' },
];

export const KLINE_TABLE_NAME = 'kline';
