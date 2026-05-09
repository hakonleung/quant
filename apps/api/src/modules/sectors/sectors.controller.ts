import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  QuantError,
  SectorPublishBodySchema,
  SectorsReplaceBodySchema,
  type Sector,
  type SectorPublishBody,
  type SectorsReplaceBody,
} from '@quant/shared';

import { type RequestWithTraceId } from '../../common/trace.middleware.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
import { SectorsService } from './sectors.service.js';

const replacePipe = new ZodValidationPipe(SectorsReplaceBodySchema);
const publishPipe = new ZodValidationPipe(SectorPublishBodySchema);

@Controller('sectors')
export class SectorsController {
  constructor(@Inject(SectorsService) private readonly service: SectorsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): { readonly sectors: readonly Sector[] } {
    return { sectors: this.service.listVisibleTo(user.id) };
  }

  @Put()
  async replace(
    @CurrentUser() user: AuthenticatedUser,
    @Body(replacePipe) body: SectorsReplaceBody,
  ): Promise<{ readonly sectors: readonly Sector[] }> {
    try {
      const sectors = await this.service.replaceForUser(user.id, body.sectors);
      return { sectors };
    } catch (err) {
      mapError(err);
    }
  }

  @Post(':id/publish')
  async publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(publishPipe) body: SectorPublishBody,
  ): Promise<{ readonly sector: Sector }> {
    try {
      const sector = await this.service.setPublished(user.id, id, body.published);
      return { sector };
    } catch (err) {
      mapError(err);
    }
  }

  @Post(':id/refresh')
  async refresh(
    @Req() req: RequestWithTraceId,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ readonly sector: Sector }> {
    try {
      const sector = await this.service.refreshDynamic(user.id, id, req.traceId);
      return { sector };
    } catch (err) {
      mapError(err);
    }
  }
}

function mapError(err: unknown): never {
  if (err instanceof QuantError) {
    if (err.code === 'NOT_FOUND') {
      throw new NotFoundException({ code: err.code, message: err.message, details: err.details });
    }
    if (err.code === 'FORBIDDEN') {
      throw new ForbiddenException({ code: err.code, message: err.message, details: err.details });
    }
  }
  throw err as Error;
}
