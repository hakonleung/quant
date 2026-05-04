/**
 * HTTP routes for stock metadata (modules/01-stock-meta.md §6.2).
 *
 *   GET /api/stocks/:code              → StockMetaDto                | 404 if not found
 *   GET /api/stocks/batch?codes=a,b    → StockMetaDto[]              | sorted as input
 *   GET /api/stocks/by-industry?sw_l2= → StockMetaDto[]              | sorted by code
 *   GET /api/stocks/snapshots?codes=…  → StockSnapshotDto[]          | sorted as input
 *
 * Search-by-name lands later (depends on a Python pinyin index — see
 * modules/01-stock-meta.md §6.1).
 *
 * Read endpoints are pure reads — they no longer side-enqueue meta or
 * kline jobs. The only enqueue paths are now the daily 15:15 BJT cron
 * and the manual POST /api/orchestration/scan.
 */

import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { StockMetaDto, StockSnapshotDto } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import type { RequestWithTraceId } from '../../common/trace.middleware.js';
import { GetBatchQuerySchema, type GetBatchQuery } from './dto/get-batch.dto.js';
import { ListByIndustryQuerySchema, type ListByIndustryQuery } from './dto/list-by-industry.dto.js';
import { StockMetaService } from './stock-meta.service.js';

const getBatchPipe = new ZodValidationPipe(GetBatchQuerySchema);
const listByIndustryPipe = new ZodValidationPipe(ListByIndustryQuerySchema);
// Snapshot accepts the same `?codes=` shape as /batch — re-use the schema.
const snapshotsPipe = new ZodValidationPipe(GetBatchQuerySchema);

@Controller('stocks')
export class StockMetaController {
  constructor(@Inject(StockMetaService) private readonly service: StockMetaService) {}

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

  @Get('snapshots')
  async listSnapshots(
    @Req() req: Request,
    @Query(snapshotsPipe) query: GetBatchQuery,
  ): Promise<readonly StockSnapshotDto[]> {
    return this.service.listSnapshots(query.codes, traceId(req));
  }

  @Get(':code')
  async getOne(@Req() req: Request, @Param('code') code: string): Promise<StockMetaDto> {
    return this.service.get(code, traceId(req));
  }
}

function traceId(req: Request): string {
  return (req as Partial<RequestWithTraceId>).traceId ?? '';
}
