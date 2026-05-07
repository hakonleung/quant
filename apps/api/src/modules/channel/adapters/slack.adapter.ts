/**
 * Slack adapter — outbound via `chat.postMessage` (Web API), inbound via
 * Socket Mode (`@slack/socket-mode`). Socket Mode keeps everything on
 * one outbound WebSocket so we don't need a public ingress to receive
 * events — works in localhost dev with the same .env that powers the
 * outbound bot token.
 *
 * Inbound events captured: `message` (channel + IM), excluding our own
 * bot's echoes (`subtype === 'bot_message'` from the same bot user).
 *
 * Failures: any send error bubbles up to the BullMQ worker so the queue
 * can retry; never swallowed silently.
 */

import { Logger } from '@nestjs/common';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

import type { SlackConfig } from '../config/channel.config.js';
import type {
  ChannelAdapter,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
  OutboundResult,
} from '../ports/channel-adapter.port.js';

interface SlackEventEnvelope {
  readonly ack: () => Promise<void>;
  readonly body?: {
    readonly event?: {
      readonly type?: string;
      readonly subtype?: string;
      readonly user?: string;
      readonly bot_id?: string;
      readonly channel?: string;
      readonly text?: string;
      readonly ts?: string;
    };
  };
  readonly event?: {
    readonly type?: string;
    readonly subtype?: string;
    readonly user?: string;
    readonly bot_id?: string;
    readonly channel?: string;
    readonly text?: string;
    readonly ts?: string;
  };
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly id = 'slack' as const;
  private readonly logger = new Logger('SlackChannelAdapter');
  private readonly web: WebClient;
  private readonly socket: SocketModeClient | null;
  private readonly handlers: InboundHandler[] = [];
  private ready = false;
  private inboundConnected = false;
  private selfBotUserId: string | null = null;

  constructor(
    private readonly cfg: SlackConfig,
    private readonly dryRun: boolean,
  ) {
    this.web = new WebClient(cfg.botToken);
    this.socket =
      cfg.appToken !== null && !dryRun ? new SocketModeClient({ appToken: cfg.appToken }) : null;
  }

  async start(): Promise<void> {
    if (!this.dryRun) {
      try {
        const auth = await this.web.auth.test();
        if (typeof auth.user_id === 'string') this.selfBotUserId = auth.user_id;
      } catch (err) {
        this.logger.warn(`slack_auth_test_failed err=${String(err)}`);
      }
    }
    if (this.socket !== null) {
      this.socket.on('connected', () => {
        this.inboundConnected = true;
        this.logger.log('slack_socket_connected');
      });
      this.socket.on('disconnected', () => {
        this.inboundConnected = false;
        this.logger.warn('slack_socket_disconnected');
      });
      this.socket.on('message', (env: SlackEventEnvelope) => {
        void this.dispatchEvent(env);
      });
      try {
        await this.socket.start();
      } catch (err) {
        this.logger.warn(`slack_socket_start_failed err=${String(err)}`);
      }
    }
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.socket !== null) {
      try {
        await this.socket.disconnect();
      } catch {
        /* noop */
      }
    }
    this.inboundConnected = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  isInboundConnected(): boolean {
    return this.inboundConnected;
  }

  subscribe(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage, traceId: string): Promise<OutboundResult> {
    const target = message.target ?? this.cfg.defaultChannel;
    if (this.dryRun) {
      this.logger.log(
        `slack_send_dryrun trace_id=${traceId} target=${target} text=${message.text.slice(0, 80)}`,
      );
      return { status: 'dryrun', target };
    }
    const text = message.title !== undefined ? `*${message.title}*\n${message.text}` : message.text;
    const res = await this.web.chat.postMessage({ channel: target, text });
    return {
      status: 'sent',
      target,
      ...(typeof res.ts === 'string' ? { providerMessageId: res.ts } : {}),
      raw: { ok: res.ok },
    };
  }

  private async dispatchEvent(envelope: SlackEventEnvelope): Promise<void> {
    try {
      await envelope.ack();
    } catch {
      /* socket-mode auto-acks on some paths; ignore double-ack */
    }
    const event = envelope.event ?? envelope.body?.event;
    if (event === undefined) return;
    if (event.type !== 'message') return;
    if (event.subtype === 'bot_message') return;
    if (event.bot_id !== undefined) return;
    if (this.selfBotUserId !== null && event.user === this.selfBotUserId) return;
    if (typeof event.text !== 'string' || event.text.length === 0) return;
    const inbound: InboundMessage = {
      channel: 'slack',
      sender: `slack:${event.user ?? 'unknown'}`,
      text: event.text,
      ...(typeof event.channel === 'string' ? { target: event.channel } : {}),
      receivedAt: new Date().toISOString(),
      raw: event,
    };
    for (const h of this.handlers) {
      try {
        await h(inbound);
      } catch (err) {
        this.logger.warn(`slack_inbound_handler_err err=${String(err)}`);
      }
    }
  }
}
