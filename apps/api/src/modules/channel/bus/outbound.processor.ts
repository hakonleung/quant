/**
 * BullMQ worker that drains the `channel.outbound` queue.
 *
 * For each job we look up the right adapter, call `send`, and then push
 * a `ChannelActivity` row onto the realtime feed reflecting the outcome
 * (`status: sent | failed | dryrun`). On exception, BullMQ retries per
 * the `attempts` config in `ChannelBus.enqueueOutbound`.
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { type ChannelActivity } from '@quant/shared';
import { type Job } from 'bullmq';

import { ChannelRegistry } from '../channel.registry.js';
import { ChannelBus, CHANNEL_OUTBOUND_QUEUE, type OutboundJob } from './channel-bus.service.js';

@Processor(CHANNEL_OUTBOUND_QUEUE)
export class ChannelOutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelOutboundProcessor.name);

  constructor(
    @Inject(ChannelRegistry) private readonly registry: ChannelRegistry,
    @Inject(ChannelBus) private readonly bus: ChannelBus,
  ) {
    super();
  }

  async process(job: Job<OutboundJob>): Promise<{ ok: boolean }> {
    const data = job.data;
    const adapter = this.registry.get(data.channel);
    if (adapter === null) {
      const activity: ChannelActivity = {
        id: `${data.id}:failed`,
        ts: new Date().toISOString(),
        channel: data.channel,
        source: data.source,
        kind: data.kind,
        text: data.message.text,
        title: data.message.title,
        status: 'failed',
        error: 'channel_not_enabled',
        traceId: data.traceId,
        meta: data.message.meta,
      };
      this.bus.publishActivity(activity);
      return { ok: false };
    }
    try {
      const result = await adapter.send(data.message, data.traceId);
      const activity: ChannelActivity = {
        id: `${data.id}:done`,
        ts: new Date().toISOString(),
        channel: data.channel,
        source: data.source,
        kind: data.kind,
        text: data.message.text,
        title: data.message.title,
        status: result.status,
        target: result.target,
        traceId: data.traceId,
        meta: data.message.meta,
      };
      this.bus.publishActivity(activity);
      return { ok: true };
    } catch (err) {
      this.logger.warn(`outbound_send_failed channel=${data.channel} err=${String(err)}`);
      const activity: ChannelActivity = {
        id: `${data.id}:err`,
        ts: new Date().toISOString(),
        channel: data.channel,
        source: data.source,
        kind: data.kind,
        text: data.message.text,
        title: data.message.title,
        status: 'failed',
        error: String(err),
        traceId: data.traceId,
        meta: data.message.meta,
      };
      this.bus.publishActivity(activity);
      throw err;
    }
  }
}
