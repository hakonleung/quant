/**
 * In-process publish surface for the realtime gateway.
 *
 * Other modules inject `SocketBus` and call `emit(topic, payload)` for a
 * public broadcast or `emitTo(userId, topic, payload)` for a user-scoped
 * room (`user:{userId}`). Both forms validate against the topic's zod
 * schema (CLAUDE.md §1.2 — no unvalidated outbound traffic) and forward
 * to the gateway, which fans out to the appropriate room.
 *
 * The gateway registers itself via `setSink(...)` on `onModuleInit` so
 * `SocketBus` stays free of a circular dependency on `SocketGateway`.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  SOCKET_TOPIC_SCHEMAS,
  type SocketEnvelope,
  type SocketTopic,
  type SocketTopicPayload,
} from '@quant/shared';

export interface SocketSink {
  publish(topic: SocketTopic, envelope: SocketEnvelope): void;
  publishTo(userId: string, topic: SocketTopic, envelope: SocketEnvelope): void;
}

@Injectable()
export class SocketBus {
  private readonly logger = new Logger(SocketBus.name);
  private sink: SocketSink | null = null;

  setSink(sink: SocketSink): void {
    this.sink = sink;
  }

  emit<T extends SocketTopic>(topic: T, payload: SocketTopicPayload<T>): void {
    const envelope = this.buildEnvelope(topic, payload);
    if (envelope === null || this.sink === null) return;
    this.sink.publish(topic, envelope);
  }

  emitTo<T extends SocketTopic>(
    userId: string,
    topic: T,
    payload: SocketTopicPayload<T>,
  ): void {
    const envelope = this.buildEnvelope(topic, payload);
    if (envelope === null || this.sink === null) return;
    this.sink.publishTo(userId, topic, envelope);
  }

  private buildEnvelope<T extends SocketTopic>(
    topic: T,
    payload: SocketTopicPayload<T>,
  ): SocketEnvelope | null {
    const schema = SOCKET_TOPIC_SCHEMAS[topic];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn(
        `socket_emit_invalid topic=${topic} err=${parsed.error.errors.map((e) => `${e.path.join('.')}:${e.message}`).join('|')}`,
      );
      return null;
    }
    return { topic, ts: new Date().toISOString(), payload: parsed.data };
  }
}
