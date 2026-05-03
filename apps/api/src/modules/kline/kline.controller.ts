/**
 * HTTP route for kline reads (modules/02-stock-kline.md §6 + 07 §4.2).
 *
 *   GET /api/kline/:code?range=30D|90D|250D
 *     → KlineBar[] sorted ascending by trade_date.
 *
 * The Python service is the single source of truth — this controller
 * only translates the human-friendly `range` to a row count, hands it
 * to the Flight op, and decodes the resulting Arrow table.
 */

import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { KlineBar } from '@quant/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import {
  arrowTableToKlineBars,
  arrowTableToKlineBarsByCode,
} from './domain/arrow-mapper.js';
import { KlineRangeQuerySchema, RANGE_TO_N, type KlineRangeQuery } from './dto/range-query.dto.js';

import { KLINE_FLIGHT_CLIENT } from './kline.token.js';

const rangePipe = new ZodValidationPipe(KlineRangeQuerySchema);

const BulkQuerySchema = z
  .object({
    codes: z.string().min(1, 'codes is required'),
    n: z.coerce.number().int().positive().max(60).default(5),
  })
  .strict();
type BulkQuery = z.infer<typeof BulkQuerySchema>;
const bulkPipe = new ZodValidationPipe(BulkQuerySchema);

@Controller('kline')
export class KlineController {
  constructor(@Inject(KLINE_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  /**
   * Bulk last-N kline. Resolves with `Record<code, KlineBar[]>`. Wired
   * before `:code` so the literal segment doesn't get caught by the
   * dynamic param.
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
    if (codes.length === 0) return {};
    const result = await this.flight.doGet(
      'list_kline_bulk_last_n',
      { codes, n: query.n },
      { traceId },
    );
    return arrowTableToKlineBarsByCode(result.value);
  }

  @Get(':code')
  async list(
    @Req() req: Request,
    @Param('code') code: string,
    @Query(rangePipe) query: KlineRangeQuery,
  ): Promise<readonly KlineBar[]> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    const n = RANGE_TO_N[query.range];
    const result = await this.flight.doGet('list_kline_for_code', { code, n }, { traceId });
    return arrowTableToKlineBars(result.value);
  }
}
