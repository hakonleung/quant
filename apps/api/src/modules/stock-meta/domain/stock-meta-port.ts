/**
 * Domain-facing port for stock-meta queries. The controller depends on
 * this interface only — the Flight adapter and the in-memory test
 * adapter both implement it. Keeping the port in `domain/` (CLAUDE.md
 * §2.5.1) means it stays IO-free at the type level.
 */

import type { StockMetaDto } from '@quant/shared';

export const STOCK_META_PORT = Symbol('STOCK_META_PORT');

export interface StockMetaPort {
  /**
   * Fetch a single stock by code. Returns `null` when no such stock
   * exists; the controller turns that into HTTP 404.
   */
  getOne(code: string, traceId: string): Promise<StockMetaDto | null>;

  /**
   * Fetch many stocks by code in input order. Codes without a record
   * are dropped from the result; callers compare lengths to detect.
   */
  getBatch(codes: readonly string[], traceId: string): Promise<readonly StockMetaDto[]>;

  /**
   * All stocks in the given Shenwan L2 industry, sorted by code.
   */
  listByIndustry(swL2: string, traceId: string): Promise<readonly StockMetaDto[]>;
}
