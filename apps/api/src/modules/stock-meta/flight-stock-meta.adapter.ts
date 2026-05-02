/**
 * `StockMetaPort` adapter that talks to the Python Flight server via
 * `FlightClient`. The two ops it consumes are `get_stock_meta_batch` and
 * `list_stock_meta_by_industry` (defined in
 * `services/py/quant_rpc/ops/stock_meta.py`).
 *
 * Single-key `getOne` is implemented on top of `get_stock_meta_batch` —
 * one fewer Flight op to maintain, and a missing key is conveyed by an
 * empty result instead of a `STOCK_NOT_FOUND` error so we don't have to
 * untangle "real" errors from "no such row".
 */

import { Inject, Injectable } from '@nestjs/common';
import type { StockMetaDto } from '@quant/shared';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { arrowTableToStockMetaDtos } from './domain/arrow-mapper.js';
import type { StockMetaPort } from './domain/stock-meta-port.js';

export const FLIGHT_CLIENT = Symbol('FLIGHT_CLIENT');

@Injectable()
export class FlightStockMetaAdapter implements StockMetaPort {
  constructor(@Inject(FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  async getOne(code: string, traceId: string): Promise<StockMetaDto | null> {
    const rows = await this.getBatch([code], traceId);
    return rows[0] ?? null;
  }

  async getBatch(codes: readonly string[], traceId: string): Promise<readonly StockMetaDto[]> {
    const result = await this.flight.doGet(
      'get_stock_meta_batch',
      { codes: [...codes] },
      { traceId },
    );
    return arrowTableToStockMetaDtos(result.value);
  }

  async listByIndustry(swL2: string, traceId: string): Promise<readonly StockMetaDto[]> {
    const result = await this.flight.doGet(
      'list_stock_meta_by_industry',
      { sw_l2: swL2 },
      { traceId },
    );
    return arrowTableToStockMetaDtos(result.value);
  }
}
