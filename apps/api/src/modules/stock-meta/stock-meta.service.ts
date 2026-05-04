/**
 * Service layer over the {@link StockMetaPort}. The controller only
 * touches this class — port implementations stay swappable (Flight,
 * in-memory test fake, future direct-DB read).
 *
 * "Missing → typed error" is owned here so every HTTP route gets the same
 * 404 mapping via `QuantErrorFilter` (no per-controller branching).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  QuantError,
  type StockMetaDto,
  type StockSnapshotDto,
} from '@quant/shared';
import { STOCK_META_PORT, type StockMetaPort } from './domain/stock-meta-port.js';

@Injectable()
export class StockMetaService {
  constructor(@Inject(STOCK_META_PORT) private readonly port: StockMetaPort) {}

  async get(code: string, traceId: string): Promise<StockMetaDto> {
    const item = await this.port.getOne(code, traceId);
    if (item === null) {
      throw new QuantError('STOCK_NOT_FOUND', `no such stock: ${code}`, { code });
    }
    return item;
  }

  async getBatch(codes: readonly string[], traceId: string): Promise<readonly StockMetaDto[]> {
    if (codes.length === 0) return [];
    return this.port.getBatch(codes, traceId);
  }

  async listByIndustry(swL2: string, traceId: string): Promise<readonly StockMetaDto[]> {
    if (swL2.length === 0) {
      throw new QuantError('INVALID_ARGUMENT', 'sw_l2 must be non-empty');
    }
    return this.port.listByIndustry(swL2, traceId);
  }

  async listAll(traceId: string): Promise<readonly StockMetaDto[]> {
    return this.port.listAll(traceId);
  }

  async listSnapshots(
    codes: readonly string[],
    traceId: string,
  ): Promise<readonly StockSnapshotDto[]> {
    if (codes.length === 0) return [];
    return this.port.listSnapshots(codes, traceId);
  }
}
