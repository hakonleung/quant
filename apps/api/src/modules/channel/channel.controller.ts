/**
 * Channel HTTP routes:
 *
 *   POST /api/channel/send   — manual outbound (replaces /api/push/test).
 *   GET  /api/channel/list   — registered channel statuses (used by
 *                              feat-channel filter chips + smoke tests).
 */

import { Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import {
  ChannelOutboundRequestSchema,
  type ChannelOutboundRequest,
  type ChannelOutboundResponse,
  type ChannelStatus,
} from '@quant/shared';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { ChannelRegistry } from './channel.registry.js';
import { ChannelService } from './channel.service.js';

const sendPipe = new ZodValidationPipe(ChannelOutboundRequestSchema);

@Controller('channel')
export class ChannelController {
  constructor(
    @Inject(ChannelService) private readonly service: ChannelService,
    @Inject(ChannelRegistry) private readonly registry: ChannelRegistry,
  ) {}

  @Get('list')
  list(): readonly ChannelStatus[] {
    return this.registry.status();
  }

  @Post('send')
  async send(
    @Body(sendPipe) body: ChannelOutboundRequest,
    @Headers('x-trace-id') traceId: string | undefined,
  ): Promise<ChannelOutboundResponse> {
    return this.service.broadcast(body, {
      traceId: traceId ?? `manual-${String(Date.now())}`,
      source: 'manual',
    });
  }
}
