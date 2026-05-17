/**
 * Channel event bus — fans out three streams:
 *
 *   1. `channel.outbound` BullMQ queue: durable retries for IM sends.
 *      The worker (`OutboundProcessor`) pops jobs and asks the matching
 *      adapter to ship them.
 *   2. `channel.activity` topic on the realtime socket bus: every send
 *      (both queued and post-delivery state changes) and every inbound
 *      message lands here so the frontend feed stays live.
 *   3. NestJS in-process EventEmitter2 events `channel.inbound` and
 *      `channel.inbound:<channelId>`: lets other modules subscribe to
 *      IM input without owning a Redis client.
 *
 * The two-tier design is deliberate:
 *   - Redis/Bull is for **guaranteed delivery** of outbound IM (retry,
 *     persistence across restart).
 *   - EventEmitter is for **in-process consumers** that already share
 *     the API process; pulling them through Redis would just add hops.
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ServerConfigCenter } from '@quant/config/server';
import { type ChannelActivity, type ChannelId, type ChannelMessageSource } from '@quant/shared';
import { Queue } from 'bullmq';

import { SocketBus } from '../../socket/socket-bus.service.js';
import type { InboundMessage, OutboundMessage } from '../ports/channel-adapter.port.js';

export const CHANNEL_OUTBOUND_QUEUE = 'channel.outbound';
export const CHANNEL_INBOUND_EVENT = 'channel.inbound';

export interface OutboundJob {
  readonly id: string;
  readonly traceId: string;
  readonly channel: ChannelId;
  readonly source: ChannelMessageSource;
  readonly kind: string;
  readonly message: OutboundMessage;
}

@Injectable()
export class ChannelBus {
  private readonly logger = new Logger(ChannelBus.name);

  constructor(
    @InjectQueue(CHANNEL_OUTBOUND_QUEUE) private readonly outboundQueue: Queue<OutboundJob>,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
    @Inject(SocketBus) private readonly sockets: SocketBus,
  ) {}

  async enqueueOutbound(job: OutboundJob): Promise<void> {
    const bus = ServerConfigCenter.get().channel.bus;
    await this.outboundQueue.add(job.kind, job, {
      jobId: job.id,
      attempts: bus.attempts,
      backoff: { type: 'exponential', delay: bus.backoffDelayMs },
      removeOnComplete: bus.removeOnComplete,
      removeOnFail: bus.removeOnFail,
    });
  }

  publishActivity(activity: ChannelActivity): void {
    this.sockets.emit('channel.activity', activity);
  }

  publishInbound(activity: ChannelActivity, raw: InboundMessage): void {
    // Realtime feed gets the activity row.
    this.publishActivity(activity);
    // In-process subscribers get a typed event.
    this.emitter.emit(CHANNEL_INBOUND_EVENT, raw);
    this.emitter.emit(`${CHANNEL_INBOUND_EVENT}:${raw.channel}`, raw);
    this.logger.log(`channel_inbound channel=${raw.channel} sender=${raw.sender}`);
  }
}
