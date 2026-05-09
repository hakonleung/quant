/**
 * Socket.IO gateway — replaces the per-feature SSE endpoints with a
 * single bidirectional channel.
 *
 *   client.emit('subscribe',   { topics: ['watch.snapshot', ...] })
 *   client.emit('unsubscribe', { topics: [...] })
 *   client.emit('command',     { id: 'channel.send', args: {...} })
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

import { AuthConfig } from '../auth/config/auth.config.js';
import { SESSION_VERIFIER, type SessionVerifier } from '../auth/ports/session-verifier.port.js';
import { corsOriginCallback } from './cors-origin.js';
import { SocketBus, type SocketSink } from './socket-bus.service.js';

interface SocketData {
  userId: string;
  /** Pre-mapping userId, set only when AUTH_ADMIN_USER_IDS promoted us. */
  originalUserId?: string;
}

export const SOCKET_COMMAND_HANDLER = Symbol('SOCKET_COMMAND_HANDLER');

export interface SocketCommandPrincipal {
  readonly userId: string;
  readonly originalUserId?: string;
}

export interface SocketCommandHandler {
  handle(
    command: SocketCommand,
    traceId: string,
    principal: SocketCommandPrincipal,
  ): Promise<SocketCommandAck>;
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
    @Inject(AuthConfig) private readonly authCfg: AuthConfig,
    @Inject(SESSION_VERIFIER) private readonly verifier: SessionVerifier,
  ) {}

  onModuleInit(): void {
    this.bus.setSink(this);
  }

  async handleConnection(client: Socket): Promise<void> {
    const resolved = await this.resolvePrincipal(client);
    if (resolved === null) {
      this.logger.warn(`socket_reject_unauthenticated id=${client.id}`);
      client.disconnect(true);
      return;
    }
    const data = client.data as SocketData;
    data.userId = resolved.userId;
    if (resolved.originalUserId !== undefined) data.originalUserId = resolved.originalUserId;
    await client.join(`user:${resolved.userId}`);
    this.logger.log(
      `socket_open id=${client.id} user=${resolved.userId}${
        resolved.originalUserId !== undefined ? ` mapped_from=${resolved.originalUserId}` : ''
      }`,
    );
  }

  private async resolvePrincipal(client: Socket): Promise<SocketCommandPrincipal | null> {
    if (this.authCfg.mode === 'disabled') return { userId: this.authCfg.adminUserId };
    const cookieHeader = client.handshake.headers['cookie'];
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    const tokenFromAuth = typeof auth?.token === 'string' ? auth.token : null;
    const token = tokenFromAuth ?? readCookieToken(cookieHeader);
    if (token === null) return null;
    const claims = await this.verifier.verify(token);
    if (claims === null) return null;
    // Symmetric admin promotion at the socket boundary too — keeps the
    // /usr instruction's "mapped_from" line coherent regardless of whether
    // the caller hit us via REST or the realtime channel.
    if (this.authCfg.adminUserIds.has(claims.userId)) {
      return { userId: this.authCfg.adminUserId, originalUserId: claims.userId };
    }
    return { userId: claims.userId };
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`socket_close id=${client.id}`);
  }

  publish(topic: SocketTopic, envelope: SocketEnvelope): void {
    this.server.to(topic).emit('event', envelope);
  }

  publishTo(userId: string, topic: SocketTopic, envelope: SocketEnvelope): void {
    // Per-user fanout uses a compound room name `user:{userId}:{topic}`
    // populated by `onSubscribe` for sockets carrying the matching
    // userId. Plain `topic` rooms hold every subscriber and are kept
    // for non-user-scoped public broadcasts.
    this.server.to(`user:${userId}:${topic}`).emit('event', envelope);
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
    const userId = (client.data as SocketData).userId;
    for (const topic of parsed.data.topics) {
      void client.join(topic);
      if (userId !== undefined) {
        void client.join(`user:${userId}:${topic}`);
      }
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
    const userId = (client.data as SocketData).userId;
    for (const topic of parsed.data.topics) {
      void client.leave(topic);
      if (userId !== undefined) {
        void client.leave(`user:${userId}:${topic}`);
      }
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
    const data = client.data as SocketData;
    if (data.userId === undefined) {
      return { ok: false, error: 'unauthenticated' };
    }
    const principal: SocketCommandPrincipal = {
      userId: data.userId,
      ...(data.originalUserId !== undefined ? { originalUserId: data.originalUserId } : {}),
    };
    try {
      return await this.commandHandler.handle(parsed.data, traceId, principal);
    } catch (err) {
      this.logger.warn(`socket_command_failed err=${String(err)}`);
      return { ok: false, error: String(err) };
    }
  }
}

const NEXTAUTH_COOKIE_NAMES = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
] as const;

function readCookieToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!NEXTAUTH_COOKIE_NAMES.includes(k as (typeof NEXTAUTH_COOKIE_NAMES)[number])) continue;
    const v = part.slice(eq + 1).trim();
    return v.length > 0 ? decodeURIComponent(v) : null;
  }
  return null;
}
