/**
 * Public facade for the channel module.
 *
 * Other backend modules (watch, orchestration) inject `ChannelService`
 * and call `broadcast(...)` for system pushes. The service:
 *   1. Resolves which channels to ship to (explicit list, else all
 *      enabled).
 *   2. Pushes a `pending` `ChannelActivity` immediately so the FE feed
 *      shows the user "an attempt is underway" before the network call
 *      completes (BullMQ workers may be milliseconds-late).
 *   3. Enqueues one outbound job per channel for durable retry.
 *
 * The post-delivery activity row (with `status: sent | failed | dryrun`)
 * is published from the BullMQ worker so the frontend sees both the
 * intent and the outcome.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  type ChannelActivity,
  type ChannelId,
  type ChannelMessageSource,
  type ChannelOutboundRequest,
  type ChannelOutboundResponse,
} from '@quant/shared';
import { randomUUID } from 'node:crypto';

import { ChannelBus, type OutboundJob } from './bus/channel-bus.service.js';
import { ChannelRegistry } from './channel.registry.js';
import type { OutboundMessage } from './ports/channel-adapter.port.js';

export interface BroadcastOptions {
  readonly traceId: string;
  readonly source?: ChannelMessageSource;
  readonly channels?: readonly ChannelId[];
}

@Injectable()
export class ChannelService {
  constructor(
    @Inject(ChannelRegistry) private readonly registry: ChannelRegistry,
    @Inject(ChannelBus) private readonly bus: ChannelBus,
  ) {}

  async broadcast(
    request: ChannelOutboundRequest,
    options: BroadcastOptions,
  ): Promise<ChannelOutboundResponse> {
    const targets = this.pickTargets(request.channels);
    const source: ChannelMessageSource = options.source ?? 'manual';
    const activityIds: string[] = [];
    const message: OutboundMessage = {
      text: request.text,
      kind: request.kind,
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.target !== undefined ? { target: request.target } : {}),
      ...(request.meta !== undefined ? { meta: request.meta } : {}),
    };

    for (const channel of targets) {
      const id = randomUUID();
      activityIds.push(id);
      // Optimistic "pending" row — the worker overrides with sent/failed.
      const pending: ChannelActivity = {
        id,
        ts: new Date().toISOString(),
        channel,
        source,
        kind: request.kind,
        text: request.text,
        ...(request.title !== undefined ? { title: request.title } : {}),
        status: 'pending',
        traceId: options.traceId,
        ...(request.meta !== undefined ? { meta: request.meta } : {}),
      };
      this.bus.publishActivity(pending);
      const job: OutboundJob = {
        id,
        traceId: options.traceId,
        channel,
        source,
        kind: request.kind,
        message,
      };
      await this.bus.enqueueOutbound(job);
    }

    return { accepted: [...targets], activityIds };
  }

  /**
   * Convenience: send a one-shot message to a single channel by id. Used
   * by the controller's `POST /api/channel/send` and by the socket
   * `command` handler.
   */
  async send(
    channel: ChannelId,
    request: ChannelOutboundRequest,
    options: BroadcastOptions,
  ): Promise<ChannelOutboundResponse> {
    return this.broadcast({ ...request, channels: [channel] }, options);
  }

  private pickTargets(requested: readonly ChannelId[] | undefined): readonly ChannelId[] {
    const enabled = this.registry.ids();
    if (requested === undefined || requested.length === 0) return enabled;
    const allowed = new Set<ChannelId>(enabled);
    return requested.filter((id) => allowed.has(id));
  }
}
