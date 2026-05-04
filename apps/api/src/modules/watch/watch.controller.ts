/**
 * HTTP routes for module W-0 (`docs/modules/W-0-watch.md` §10).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { StockBasic, WatchTask } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import {
  UniverseQuerySchema,
  WatchTaskCreateSchema,
  WatchTaskParamsSchema,
  WatchTaskPatchSchema,
  type UniverseQuery,
  type WatchTaskCreate,
  type WatchTaskParams,
  type WatchTaskPatch,
} from './dto/watch.dto.js';
import { WatchService } from './watch.service.js';

const createPipe = new ZodValidationPipe(WatchTaskCreateSchema);
const patchPipe = new ZodValidationPipe(WatchTaskPatchSchema);
const paramsPipe = new ZodValidationPipe(WatchTaskParamsSchema);
const universePipe = new ZodValidationPipe(UniverseQuerySchema);

@Controller('watch')
export class WatchController {
  constructor(private readonly service: WatchService) {}

  @Get()
  list(): readonly WatchTask[] {
    return this.service.list();
  }

  @Post()
  async create(@Body(createPipe) body: WatchTaskCreate): Promise<WatchTask> {
    return this.service.create(body);
  }

  @Patch(':market/:code')
  async patch(
    @Param(paramsPipe) params: WatchTaskParams,
    @Body(patchPipe) body: WatchTaskPatch,
  ): Promise<WatchTask> {
    return this.service.patch(params.market, params.code, body);
  }

  @Delete(':market/:code')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param(paramsPipe) params: WatchTaskParams): Promise<void> {
    await this.service.delete(params.market, params.code);
  }

  @Get('universe')
  async universe(
    @Query(universePipe) query: UniverseQuery,
  ): Promise<readonly StockBasic[]> {
    return this.service.getUniverse(query.market);
  }

  @Post('universe/refresh')
  async refresh(
    @Query(universePipe) query: UniverseQuery,
  ): Promise<readonly StockBasic[]> {
    return this.service.refreshUniverse(query.market);
  }
}
