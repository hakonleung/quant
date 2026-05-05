import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { SectorsReplaceBodySchema, type Sector, type SectorsReplaceBody } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { SectorsStore } from './sectors.store.js';

const replacePipe = new ZodValidationPipe(SectorsReplaceBodySchema);

@Controller('sectors')
export class SectorsController {
  constructor(@Inject(SectorsStore) private readonly store: SectorsStore) {}

  @Get()
  list(): { readonly sectors: readonly Sector[] } {
    return { sectors: this.store.list() };
  }

  @Put()
  async replace(
    @Body(replacePipe) body: SectorsReplaceBody,
  ): Promise<{ readonly sectors: readonly Sector[] }> {
    const sectors = await this.store.replace(body.sectors);
    return { sectors };
  }
}
