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

import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { StockMetaDto } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import type { RequestWithTraceId } from '../../common/trace.middleware.js';
import { KLINE_QUEUE, META_QUEUE } from '../orchestration/flight.token.js';
import type { InMemoryQueue } from '../orchestration/domain/in-memory-queue.js';
import type { KlineJob, MetaJob } from '../orchestration/domain/types.js';
import { GetBatchQuerySchema, type GetBatchQuery } from './dto/get-batch.dto.js';
import { ListByIndustryQuerySchema, type ListByIndustryQuery } from './dto/list-by-industry.dto.js';
import { StockMetaService } from './stock-meta.service.js';

const getBatchPipe = new ZodValidationPipe(GetBatchQuerySchema);
const listByIndustryPipe = new ZodValidationPipe(ListByIndustryQuerySchema);

@Controller('stocks')
export class StockMetaController {
  constructor(
    @Inject(StockMetaService) private readonly service: StockMetaService,
    @Inject(META_QUEUE) private readonly metaQueue: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly klineQueue: InMemoryQueue<KlineJob>,
  ) {}

  /** Order matters: literal sub-paths must be declared before the `/:code` capture. */
  @Get()
  async listAll(@Req() req: Request): Promise<readonly StockMetaDto[]> {
    const tid = traceId(req);
    const rows = await this.service.listAll(tid);
    this.scheduleMissing(rows, tid);
    return rows;
  }

  @Get('batch')
  async getBatch(
    @Req() req: Request,
    @Query(getBatchPipe) query: GetBatchQuery,
  ): Promise<readonly StockMetaDto[]> {
    const tid = traceId(req);
    const rows = await this.service.getBatch(query.codes, tid);
    this.scheduleMissing(rows, tid);
    return rows;
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
    const tid = traceId(req);
    const dto = await this.service.get(code, tid);
    this.scheduleMissing([dto], tid);
    return dto;
  }

  private scheduleMissing(rows: readonly StockMetaDto[], tid: string): void {
    for (const row of rows) {
      if (row.industries === '') {
        this.metaQueue.add(
          { kind: 'enrich', code: row.code, traceId: tid },
          { id: `enrich:${row.code}` },
        );
      }
      // Best-effort: also nudge a kline sync — dedup keeps it cheap.
      this.klineQueue.add(
        { kind: 'sync', code: row.code, traceId: tid },
        { id: `sync:${row.code}` },
      );
    }
  }
}

function traceId(req: Request): string {
  return (req as Partial<RequestWithTraceId>).traceId ?? '';
}
