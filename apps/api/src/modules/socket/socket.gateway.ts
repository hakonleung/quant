/**
 * Socket.IO gateway — replaces the per-feature SSE endpoints with a
 * single bidirectional channel.
 *
 *   client.emit('subscribe',   { topics: ['watch.snapshot', ...] })
 *   client.emit('unsubscribe', { topics: [...] })
 *   client.emit('command',     { kind: 'channel.send', ... })  // TODO surface
 *   server.emit('event',       { topic, ts, payload })
 *
 * Subscribed clients are placed in a Socket.IO room named after the
 * topic; `SocketBus.emit(topic, ...)` fans out exactly to that room so
 * unsubscribed clients pay zero serialization cost.
 *
 * CORS uses the shared `corsOriginCallback` (same-host different-port
 * + loopback) so the Next dev server (3000/3100) can reach the Nest API
 * (3001) without a wildcard origin.
 */

import { Inject, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import {
  SocketCommandSchema,
  SocketSubscribeRequestSchema,
  type SocketCommand,
  type SocketCommandAck,
  type SocketEnvelope,
  type SocketTopic,
} from '@quant/shared';
import type { Server, Socket } from 'socket.io';

import { corsOriginCallback } from './cors-origin.js';
import { SocketBus, type SocketSink } from './socket-bus.service.js';

export const SOCKET_COMMAND_HANDLER = Symbol('SOCKET_COMMAND_HANDLER');

export interface SocketCommandHandler {
  handle(command: SocketCommand, traceId: string): Promise<SocketCommandAck>;
}

@WebSocketGateway({
  cors: {
    origin: corsOriginCallback,
    credentials: true,
  },
  // Reasonable defaults for an internal LAN/loopback deploy.
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
export class SocketGateway
  implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect, SocketSink
{
  private readonly logger = new Logger(SocketGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(SocketBus) private readonly bus: SocketBus,
    @Inject(SOCKET_COMMAND_HANDLER)
    private readonly commandHandler: SocketCommandHandler,
  ) {}

  onModuleInit(): void {
    this.bus.setSink(this);
  }

  handleConnection(client: Socket): void {
    this.logger.log(`socket_open id=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`socket_close id=${client.id}`);
  }

  publish(topic: SocketTopic, envelope: SocketEnvelope): void {
    this.server.to(topic).emit('event', envelope);
  }

  @SubscribeMessage('subscribe')
  onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean; subscribed?: readonly string[]; error?: string } {
    const parsed = SocketSubscribeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: 'invalid_subscribe_payload' };
    }
    for (const topic of parsed.data.topics) {
      void client.join(topic);
    }
    return { ok: true, subscribed: parsed.data.topics };
  }

  @SubscribeMessage('unsubscribe')
  onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean; unsubscribed?: readonly string[]; error?: string } {
    const parsed = SocketSubscribeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: 'invalid_unsubscribe_payload' };
    }
    for (const topic of parsed.data.topics) {
      void client.leave(topic);
    }
    return { ok: true, unsubscribed: parsed.data.topics };
  }

  @SubscribeMessage('command')
  async onCommand(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<SocketCommandAck> {
    const parsed = SocketCommandSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: 'invalid_command_payload' };
    }
    const traceId = `sock-${client.id}-${String(Date.now())}`;
    try {
      return await this.commandHandler.handle(parsed.data, traceId);
    } catch (err) {
      this.logger.warn(`socket_command_failed err=${String(err)}`);
      return { ok: false, error: String(err) };
    }
  }
}
