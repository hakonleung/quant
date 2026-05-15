/**
 * HTTP route for kline reads (modules/02-stock-kline.md §6 + 07 §4.2).
 *
 *   GET /api/kline/:code?range=30D|90D|250D
 *     → KlineBar[] sorted ascending by trade_date.
 *
 * Reads come from the local `DuckDBParquetTimeSeriesStore` via
 * `KlineReaderService`. Python no longer persists kline; it computes
 * and pushes back through the writer service (plan §3.3 — Phase 2).
 */

import { Controller, Get, Inject, Logger, Param, Query, Req } from '@nestjs/common';
import type { KlineBar } from '@quant/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { KlineReaderService } from './kline-reader.service.js';
import { KlineRangeQuerySchema, RANGE_TO_N, type KlineRangeQuery } from './dto/range-query.dto.js';

const rangePipe = new ZodValidationPipe(KlineRangeQuerySchema);

const BulkQuerySchema = z
  .object({
    /** Comma-separated 6-digit codes; empty = full universe. */
    codes: z.string().default(''),
    n: z.coerce.number().int().positive().max(60).default(5),
  })
  .strict();
type BulkQuery = z.infer<typeof BulkQuerySchema>;
const bulkPipe = new ZodValidationPipe(BulkQuerySchema);

@Controller('kline')
export class KlineController {
  private readonly logger = new Logger(KlineController.name);

  constructor(@Inject(KlineReaderService) private readonly reader: KlineReaderService) {}

  /**
   * Bulk last-N kline. Resolves with `Record<code, KlineBar[]>`.
   * Empty `codes` → full universe (every code with at least one bar in
   * the local store).
   *
   * Best-effort by contract: a local-store error degrades to an empty
   * `{}` with HTTP 200 because the list-panel renders a "—" for codes
   * without stats but breaks for the whole sector if this endpoint
   * 4xx/5xx's. The underlying error is logged at WARN with the trace id.
   *
   * Wired before `:code` so the literal segment doesn't get caught by
   * the dynamic param.
   */
  @Get('bulk')
  async listBulk(
    @Req() req: Request,
    @Query(bulkPipe) query: BulkQuery,
  ): Promise<Record<string, readonly KlineBar[]>> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    const codes = query.codes
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{6}$/.test(s));
    try {
      return await this.reader.lastNBulk(codes, query.n);
    } catch (err) {
      this.logger.warn(
        `kline_bulk_fallback trace=${traceId} codes=${String(codes.length)} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {};
    }
  }

  @Get(':code')
  async list(
    @Req() _req: Request,
    @Param('code') code: string,
    @Query(rangePipe) query: KlineRangeQuery,
  ): Promise<readonly KlineBar[]> {
    void _req;
    const n = RANGE_TO_N[query.range];
    return this.reader.lastNForCode(code, n);
  }
}
