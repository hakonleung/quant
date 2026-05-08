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
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
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

  @Get('groups')
  listGroups(@CurrentUser() user: AuthenticatedUser): Promise<readonly WatchGroup[]> {
    return this.service.listGroups(user.id);
  }

  @Post('groups')
  async createGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Body(groupCreatePipe) body: WatchGroupCreate,
  ): Promise<WatchGroup> {
    return this.service.createGroup(user.id, body);
  }

  @Delete('groups/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param(groupParamsPipe) params: WatchGroupParams,
  ): Promise<void> {
    await this.service.deleteGroup(user.id, params.name);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<readonly WatchTask[]> {
    return this.service.list(user.id);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(createPipe) body: WatchTaskCreate,
  ): Promise<WatchTask> {
    return this.service.create(user.id, body);
  }

  @Patch(':market/:code')
  async patch(
    @CurrentUser() user: AuthenticatedUser,
    @Param(paramsPipe) params: WatchTaskParams,
    @Body(patchPipe) body: WatchTaskPatch,
  ): Promise<WatchTask> {
    return this.service.patch(user.id, params.market, params.code, body);
  }

  @Delete(':market/:code')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param(paramsPipe) params: WatchTaskParams,
  ): Promise<void> {
    await this.service.delete(user.id, params.market, params.code);
  }

  @Get('universe')
  async universe(@Query(universePipe) query: UniverseQuery): Promise<readonly StockBasic[]> {
    return this.service.getUniverse(query.market);
  }

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
