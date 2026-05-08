/**
 * Channel module composition root. Replaces the legacy push module.
 *
 *   - Loads + validates env config (`CHANNEL_*`).
 *   - Wires the BullMQ queue (`channel.outbound`) over Redis.
 *   - Registers EventEmitter2 globally (in-process bus for inbound IM).
 *   - Provides the public `ChannelService` and the socket command
 *     handler (`ChannelCommandService`) — both exported so the watch
 *     scheduler and SocketModule can consume them.
 */

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { ChannelOutboundProcessor } from './bus/outbound.processor.js';
import { ChannelBus, CHANNEL_OUTBOUND_QUEUE } from './bus/channel-bus.service.js';
import { ChannelController } from './channel.controller.js';
import { ChannelRegistry } from './channel.registry.js';
import { ChannelService } from './channel.service.js';
import { CHANNEL_CONFIG, loadChannelConfig } from './config/channel.config.js';
import { ChannelSendHandler } from './instructions/channel-send.handler.js';

@Module({
  imports: [
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 100 }),
    BullModule.forRootAsync({
      useFactory: () => {
        const cfg = loadChannelConfig();
        return {
          connection: { url: cfg.redisUrl },
          prefix: cfg.bullPrefix,
        };
      },
    }),
    BullModule.registerQueue({ name: CHANNEL_OUTBOUND_QUEUE }),
  ],
  controllers: [ChannelController],
  providers: [
    {
      provide: CHANNEL_CONFIG,
      useFactory: () => loadChannelConfig(),
    },
    ChannelRegistry,
    ChannelBus,
    ChannelOutboundProcessor,
    ChannelService,
    ChannelSendHandler,
  ],
  exports: [ChannelService],
})
export class ChannelModule {}
