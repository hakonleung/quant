import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { SysCfgSchema, type SysCfg } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { SysCfgStore } from './sys-cfg.store.js';

const replacePipe = new ZodValidationPipe(SysCfgSchema);

@Controller('sys-cfg')
export class SysCfgController {
  constructor(@Inject(SysCfgStore) private readonly store: SysCfgStore) {}

  @Get()
  get(): SysCfg {
    return this.store.get();
  }

  @Put()
  async replace(@Body(replacePipe) body: SysCfg): Promise<SysCfg> {
    return this.store.replace(body);
  }
}
