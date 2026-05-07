/**
 * Holds the live `ChannelAdapter` instances keyed by id. Owns lifecycle
 * (`onModuleInit` → `start()`, `onModuleDestroy` → `stop()`) and routes
 * adapter inbound callbacks into `ChannelBus.publishInbound`.
 *
 * Adapters are instantiated only for channels listed in `CHANNEL_ENABLED`
 * (parsed by `loadChannelConfig`). Disabled channels are absent from the
 * map, so `get(...)` returns null and outbound jobs targeting them fail
 * fast in the worker.
 */

import {
  Inject,
  Injectable,
  Logger,
  forwardRef,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type ChannelActivity,
  type ChannelId,
  type ChannelStatus,
} from '@quant/shared';
import { randomUUID } from 'node:crypto';

import { CHANNEL_CONFIG, type ChannelConfig } from './config/channel.config.js';
import { FeishuChannelAdapter } from './adapters/feishu.adapter.js';
import { SlackChannelAdapter } from './adapters/slack.adapter.js';
import { ChannelBus } from './bus/channel-bus.service.js';
import type { ChannelAdapter, InboundMessage } from './ports/channel-adapter.port.js';

@Injectable()
export class ChannelRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelRegistry.name);
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();

  constructor(
    @Inject(CHANNEL_CONFIG) private readonly cfg: ChannelConfig,
    @Inject(forwardRef(() => ChannelBus)) private readonly bus: ChannelBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.cfg.slack !== null) {
      const slack = new SlackChannelAdapter(this.cfg.slack, this.cfg.dryRun);
      slack.subscribe((m) => this.onInbound(m));
      this.adapters.set('slack', slack);
    }
    if (this.cfg.feishu !== null) {
      const feishu = new FeishuChannelAdapter(this.cfg.feishu, this.cfg.dryRun);
      feishu.subscribe((m) => this.onInbound(m));
      this.adapters.set('feishu', feishu);
    }
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.start();
      } catch (err) {
        this.logger.warn(`channel_adapter_start_failed id=${adapter.id} err=${String(err)}`);
      }
    }
    this.logger.log(
      `channel_registry_ready ids=${[...this.adapters.keys()].join(',') || '(none)'} dryRun=${String(this.cfg.dryRun)}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch {
        /* noop */
      }
    }
    this.adapters.clear();
  }

  get(id: ChannelId): ChannelAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  ids(): readonly ChannelId[] {
    return [...this.adapters.keys()];
  }

  status(): readonly ChannelStatus[] {
    const all: ChannelId[] = ['slack', 'feishu'];
    return all.map((id) => {
      const adapter = this.adapters.get(id);
      const enabled = this.cfg.enabled.has(id);
      if (adapter === undefined) {
        return {
          id,
          enabled,
          ready: false,
          inbound: false,
          ...(enabled ? { detail: 'configured but not started' } : { detail: 'disabled' }),
        };
      }
      return {
        id,
        enabled: true,
        ready: adapter.isReady(),
        inbound: adapter.isInboundConnected(),
      };
    });
  }

  private onInbound(msg: InboundMessage): void {
    const activity: ChannelActivity = {
      id: randomUUID(),
      ts: msg.receivedAt,
      channel: msg.channel,
      source: 'inbound',
      kind: 'inbound.message',
      text: msg.text,
      sender: msg.sender,
      target: msg.target,
      traceId: `inbound-${msg.channel}-${msg.receivedAt}`,
    };
    this.bus.publishInbound(activity, msg);
  }
}
