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
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import type { StockBasic, WatchTask } from '@quant/shared';
import { Observable, interval, map, startWith } from 'rxjs';
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

const STREAM_TICK_MS = 1000;

interface WatchSseChunk {
  readonly data: readonly WatchTask[];
}

@Controller('watch')
export class WatchController {
  constructor(@Inject(WatchService) private readonly service: WatchService) {}

  @Get()
  list(): readonly WatchTask[] {
    return this.service.list();
  }

  /**
   * SSE stream of the full task list at 1 Hz. The frontend subscribes to
   * this instead of polling so `lastTickAt` / `hitCount` updates land
   * within a tick of the scheduler mutating them.
   */
  @Sse('stream')
  stream(): Observable<WatchSseChunk> {
    return interval(STREAM_TICK_MS).pipe(
      startWith(0),
      map(() => ({ data: this.service.list() })),
    );
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
  async universe(@Query(universePipe) query: UniverseQuery): Promise<readonly StockBasic[]> {
    return this.service.getUniverse(query.market);
  }

  /**
   * Resolve `(market, code)` → `StockBasic`. Used by the frontend to
   * confirm a ticker before posting a task; 404 means the code is not
   * in the source of truth (stock-meta for A, on-disk universe for
   * HK / US).
   */
  @Get('lookup')
  async lookup(
    @Query(new ZodValidationPipe(WatchTaskParamsSchema)) query: WatchTaskParams,
  ): Promise<StockBasic> {
    return this.service.lookup(query.market, query.code);
  }

  @Post('universe/refresh')
  async refresh(@Query(universePipe) query: UniverseQuery): Promise<readonly StockBasic[]> {
    return this.service.refreshUniverse(query.market);
  }
}
