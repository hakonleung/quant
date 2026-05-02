/**
 * HTTP routes for stock metadata (modules/01-stock-meta.md §6.2).
 *
 *   GET /api/stocks/:code              → StockMetaDto                | 404 if not found
 *   GET /api/stocks/batch?codes=a,b    → StockMetaDto[]              | sorted as input
 *   GET /api/stocks/by-industry?sw_l2= → StockMetaDto[]              | sorted by code
 *
 * Search-by-name lands later (depends on a Python pinyin index — see
 * modules/01-stock-meta.md §6.1).
 */

import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { StockMetaDto } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import type { RequestWithTraceId } from '../../common/trace.middleware.js';
import { GetBatchQuerySchema, type GetBatchQuery } from './dto/get-batch.dto.js';
import { ListByIndustryQuerySchema, type ListByIndustryQuery } from './dto/list-by-industry.dto.js';
import { StockMetaService } from './stock-meta.service.js';

const getBatchPipe = new ZodValidationPipe(GetBatchQuerySchema);
const listByIndustryPipe = new ZodValidationPipe(ListByIndustryQuerySchema);

@Controller('stocks')
export class StockMetaController {
  constructor(private readonly service: StockMetaService) {}

  /** Order matters: literal sub-paths must be declared before the `/:code` capture. */
  @Get()
  async listAll(@Req() req: Request): Promise<readonly StockMetaDto[]> {
    return this.service.listAll(traceId(req));
  }

  @Get('batch')
  async getBatch(
    @Req() req: Request,
    @Query(getBatchPipe) query: GetBatchQuery,
  ): Promise<readonly StockMetaDto[]> {
    return this.service.getBatch(query.codes, traceId(req));
  }

  @Get('by-industry')
  async listByIndustry(
    @Req() req: Request,
    @Query(listByIndustryPipe) query: ListByIndustryQuery,
  ): Promise<readonly StockMetaDto[]> {
    return this.service.listByIndustry(query.sw_l2, traceId(req));
  }

  @Get(':code')
  async getOne(@Req() req: Request, @Param('code') code: string): Promise<StockMetaDto> {
    return this.service.get(code, traceId(req));
  }
}

function traceId(req: Request): string {
  return (req as Partial<RequestWithTraceId>).traceId ?? '';
}
