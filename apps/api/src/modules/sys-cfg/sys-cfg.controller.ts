import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { SysCfgSchema, type SysCfg } from '@quant/shared';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
import { SysCfgStore } from './sys-cfg.store.js';

const replacePipe = new ZodValidationPipe(SysCfgSchema);

@Controller('sys-cfg')
export class SysCfgController {
  constructor(@Inject(SysCfgStore) private readonly store: SysCfgStore) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<SysCfg> {
    return this.store.get(user.id);
  }

  @Put()
  async replace(
    @CurrentUser() user: AuthenticatedUser,
    @Body(replacePipe) body: SysCfg,
  ): Promise<SysCfg> {
    return this.store.replace(user.id, body);
  }
}
