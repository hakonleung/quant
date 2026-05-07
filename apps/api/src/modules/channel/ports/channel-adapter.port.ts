/**
 * Abstract IM channel surface. Each concrete adapter (slack, feishu)
 * owns its own SDK + tokens and exposes a uniform send/subscribe API
 * so `ChannelService` and the BullMQ workers stay channel-agnostic.
 */

import type { ChannelId } from '@quant/shared';

export interface OutboundMessage {
  /** Optional override (Slack channel id / Feishu chat id). */
  readonly target?: string;
  readonly title?: string;
  readonly text: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface OutboundResult {
  readonly status: 'sent' | 'dryrun';
  readonly target: string;
  readonly providerMessageId?: string;
  readonly raw?: unknown;
}

export interface InboundMessage {
  readonly channel: ChannelId;
  readonly sender: string;
  readonly text: string;
  readonly target?: string;
  readonly receivedAt: string;
  readonly raw: unknown;
}

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;

export interface ChannelAdapter {
  readonly id: ChannelId;
  /** Send a single message. Throws on transport error. */
  send(message: OutboundMessage, traceId: string): Promise<OutboundResult>;
  /** Register an inbound listener. Multiple subscribers fan out. */
  subscribe(handler: InboundHandler): void;
  /** Connect outbound + start inbound socket if available. */
  start(): Promise<void>;
  /** Tear down sockets, flush pending sends. */
  stop(): Promise<void>;
  /** True after `start()` succeeds; flips false on `stop()`. */
  isReady(): boolean;
  /** True when the inbound subscription is connected (Socket Mode etc.). */
  isInboundConnected(): boolean;
}

export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');
