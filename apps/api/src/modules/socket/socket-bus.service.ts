/**
 * In-process publish surface for the realtime gateway.
 *
 * Other modules inject `SocketBus` and call `emit(topic, payload)`; the
 * bus validates against the topic's zod schema (CLAUDE.md §1.2 — no
 * unvalidated outbound traffic) and forwards to the gateway, which
 * fans out to the room subscribed to that topic.
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
}

@Injectable()
export class SocketBus {
  private readonly logger = new Logger(SocketBus.name);
  private sink: SocketSink | null = null;

  setSink(sink: SocketSink): void {
    this.sink = sink;
  }

  emit<T extends SocketTopic>(topic: T, payload: SocketTopicPayload<T>): void {
    const schema = SOCKET_TOPIC_SCHEMAS[topic];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn(
        `socket_emit_invalid topic=${topic} err=${parsed.error.errors.map((e) => `${e.path.join('.')}:${e.message}`).join('|')}`,
      );
      return;
    }
    if (this.sink === null) {
      // Gateway not yet ready (boot order) — drop. Snapshots tick at
      // 1Hz so the next tick lands fine.
      return;
    }
    const envelope: SocketEnvelope = {
      topic,
      ts: new Date().toISOString(),
      payload: parsed.data,
    };
    this.sink.publish(topic, envelope);
  }
}
