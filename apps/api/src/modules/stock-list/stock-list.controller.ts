/**
 * `POST /stock-list/rows` — single endpoint that returns a fully
 * assembled stock list row set. Replaces the FE 3-fetch stitch
 * (`useStockMeta` + `useKlineBulk` + `useStockSnapshots`) with one
 * server-side composition.
 */

import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import {
  StockListRowsRequestSchema,
  type StockListRowsRequest,
  type StockListRowsResponse,
} from '@quant/shared';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { StockListService } from './stock-list.service.js';

@Controller('stock-list')
export class StockListController {
  constructor(@Inject(StockListService) private readonly svc: StockListService) {}

  @Post('rows')
  async rows(
    @Body(new ZodValidationPipe(StockListRowsRequestSchema)) body: StockListRowsRequest,
    @Req() req: { traceId?: string },
  ): Promise<StockListRowsResponse> {
    const traceId =
      typeof req.traceId === 'string' && req.traceId.length > 0 ? req.traceId : 'no-trace';
    return this.svc.assembleRows({
      kind: body.kind,
      codes: body.codes,
      ...(body.columns !== undefined ? { columns: body.columns } : {}),
      ...(body.sort !== undefined ? { sort: body.sort } : {}),
      traceId,
    });
  }
}
