/**
 * `WatchQuotePort` adapter that talks to the Python Flight server. Two
 * ops in play:
 *
 *   - ``watch.quote_one``           → one-row Arrow table (string Decimals)
 *   - ``watch.universe_refresh``    → N-row Arrow table (market/code/name)
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Table } from 'apache-arrow';
import {
  SpotQuoteSchema,
  StockBasicSchema,
  type SpotQuote,
  type StockBasic,
  type WatchMarket,
} from '@quant/shared';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import type { WatchQuotePort } from './domain/watch-port.js';

export const WATCH_FLIGHT_CLIENT = Symbol('WATCH_FLIGHT_CLIENT');

function arrowRowsToObjects(table: Table): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row = table.get(i);
    if (row === null || row === undefined) continue;
    const json = row.toJSON();
    out.push(json as Record<string, unknown>);
  }
  return out;
}

function tsToIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'bigint') return new Date(Number(value / 1000n)).toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}

@Injectable()
export class FlightWatchAdapter implements WatchQuotePort {
  constructor(@Inject(WATCH_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  async fetchOne(market: WatchMarket, code: string, traceId: string): Promise<SpotQuote> {
    const result = await this.flight.doGet('watch.quote_one', { market, code }, { traceId });
    const rows = arrowRowsToObjects(result.value);
    if (rows.length === 0) {
      // The handler raises on upstream failure, so an empty table is a
      // contract drift — treat it as such.
      throw new Error(`watch.quote_one returned 0 rows for ${market}:${code}`);
    }
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`watch.quote_one row index 0 missing for ${market}:${code}`);
    }
    return SpotQuoteSchema.parse({
      market: row['market'],
      code: row['code'],
      last: row['last'],
      dayHigh: row['day_high'],
      dayLow: row['day_low'],
      prevClose: row['prev_close'],
      ts: tsToIso(row['ts']),
    });
  }

  async refreshUniverse(market: 'hk' | 'us', traceId: string): Promise<readonly StockBasic[]> {
    const result = await this.flight.doGet('watch.universe_refresh', { market }, { traceId });
    const rows = arrowRowsToObjects(result.value);
    return rows.map((row) =>
      StockBasicSchema.parse({
        market: row['market'],
        code: row['code'],
        name: row['name'],
      }),
    );
  }
}
