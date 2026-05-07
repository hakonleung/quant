/**
 * HTTP routes for module W-0 (`docs/modules/W-0-watch.md` §10).
 *
 * Live streaming used to be served via `@Sse('stream')` here; it now
 * runs through the global Socket.IO gateway (`watch.snapshot` topic)
 * managed by `WatchBroadcaster`. The HTTP surface keeps the one-shot
 * list, lookup, and CRUD routes untouched.
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
} from '@nestjs/common';
import type { StockBasic, WatchGroup, WatchTask } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import {
  UniverseQuerySchema,
  WatchGroupCreateSchema,
  WatchGroupParamsSchema,
  WatchTaskCreateSchema,
  WatchTaskParamsSchema,
  WatchTaskPatchSchema,
  type UniverseQuery,
  type WatchGroupCreate,
  type WatchGroupParams,
  type WatchTaskCreate,
  type WatchTaskParams,
  type WatchTaskPatch,
} from './dto/watch.dto.js';
import { WatchService } from './watch.service.js';

const createPipe = new ZodValidationPipe(WatchTaskCreateSchema);
const patchPipe = new ZodValidationPipe(WatchTaskPatchSchema);
const paramsPipe = new ZodValidationPipe(WatchTaskParamsSchema);
const universePipe = new ZodValidationPipe(UniverseQuerySchema);
const groupCreatePipe = new ZodValidationPipe(WatchGroupCreateSchema);
const groupParamsPipe = new ZodValidationPipe(WatchGroupParamsSchema);

@Controller('watch')
export class WatchController {
  constructor(@Inject(WatchService) private readonly service: WatchService) {}

  /*
   * NOTE on route ordering: the static `groups` / `universe` / `lookup`
   * paths must be declared *before* the `:market/:code` family below,
   * otherwise Express's first-match dispatch routes them to the param
   * handler.
   */

  @Get('groups')
  listGroups(): readonly WatchGroup[] {
    return this.service.listGroups();
  }

  @Post('groups')
  async createGroup(@Body(groupCreatePipe) body: WatchGroupCreate): Promise<WatchGroup> {
    return this.service.createGroup(body);
  }

  @Delete('groups/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGroup(@Param(groupParamsPipe) params: WatchGroupParams): Promise<void> {
    await this.service.deleteGroup(params.name);
  }

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
