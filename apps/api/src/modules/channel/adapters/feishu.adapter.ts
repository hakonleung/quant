/**
 * Feishu (Lark) adapter — outbound via the Open Platform `im.message`
 * API and inbound via the long-connection `WSClient`. Mirrors the Slack
 * adapter shape so `ChannelService` doesn't care which IM it's talking
 * to.
 *
 * The lark `Client` accepts a `disableTokenCache: false` default which
 * caches the tenant access token internally. Outbound `chat_id` defaults
 * to `cfg.defaultChatId`; callers can override per-message.
 *
 * `WSClient` runs Feishu's bidirectional event channel — same role as
 * Slack Socket Mode, no public ingress required.
 */

import { Logger } from '@nestjs/common';
import * as Lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../config/channel.config.js';
import type {
  ChannelAdapter,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
  OutboundResult,
} from '../ports/channel-adapter.port.js';

interface LarkMessageEvent {
  readonly sender?: { readonly sender_id?: { readonly open_id?: string } };
  readonly message?: {
    readonly chat_id?: string;
    readonly content?: string;
    readonly create_time?: string;
    readonly message_type?: string;
  };
}

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly id = 'feishu' as const;
  private readonly logger = new Logger('FeishuChannelAdapter');
  private readonly client: Lark.Client;
  private readonly ws: Lark.WSClient | null;
  private readonly handlers: InboundHandler[] = [];
  private ready = false;
  private inboundConnected = false;

  constructor(
    private readonly cfg: FeishuConfig,
    private readonly dryRun: boolean,
  ) {
    this.client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      disableTokenCache: false,
    });
    this.ws = dryRun ? null : new Lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret });
  }

  async start(): Promise<void> {
    if (this.ws !== null) {
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: LarkMessageEvent) => {
          await this.dispatchEvent(data);
        },
      });
      try {
        // WSClient.start() returns void but kicks off the long-conn loop.
        this.ws.start({ eventDispatcher: dispatcher });
        this.inboundConnected = true;
        this.logger.log('feishu_ws_started');
      } catch (err) {
        this.logger.warn(`feishu_ws_start_failed err=${String(err)}`);
      }
    }
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.inboundConnected = false;
    // WSClient has no documented stop in this SDK version — letting GC
    // clear the loop on process exit. Tracked as a follow-up.
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
    const target = message.target ?? this.cfg.defaultChatId;
    if (target === '') {
      throw new Error('feishu_send_no_target: set CHANNEL_FEISHU_DEFAULT_CHAT_ID or pass target');
    }
    const text = message.title !== undefined ? `${message.title}\n${message.text}` : message.text;
    if (this.dryRun) {
      this.logger.log(
        `feishu_send_dryrun trace_id=${traceId} target=${target} text=${text.slice(0, 80)}`,
      );
      return { status: 'dryrun', target };
    }
    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: target,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    const messageId =
      typeof res.data?.message_id === 'string' ? res.data.message_id : null;
    return {
      status: 'sent',
      target,
      ...(messageId !== null ? { providerMessageId: messageId } : {}),
      raw: { code: res.code },
    };
  }

  private async dispatchEvent(data: LarkMessageEvent): Promise<void> {
    const msg = data.message;
    if (msg === undefined || msg.message_type !== 'text') return;
    let text = '';
    if (typeof msg.content === 'string') {
      try {
        const parsed = JSON.parse(msg.content) as { text?: string };
        text = parsed.text ?? '';
      } catch {
        text = msg.content;
      }
    }
    if (text.length === 0) return;
    const inbound: InboundMessage = {
      channel: 'feishu',
      sender: `feishu:${data.sender?.sender_id?.open_id ?? 'unknown'}`,
      text,
      ...(typeof msg.chat_id === 'string' ? { target: msg.chat_id } : {}),
      receivedAt: new Date().toISOString(),
      raw: data,
    };
    for (const h of this.handlers) {
      try {
        await h(inbound);
      } catch (err) {
        this.logger.warn(`feishu_inbound_handler_err err=${String(err)}`);
      }
    }
  }
}
