/**
 * Cross-process contract for the realtime Socket.IO bus
 * (`docs/modules/12-socket.md`).
 *
 * The single FE↔BE realtime channel. Topics are namespaced strings
 * (`<module>.<event>`); each one has a zod schema so:
 *   1. The NestJS `SocketBus` validates payloads on emit (catch drift
 *      at the source, not in the browser).
 *   2. The frontend `useSocketTopic` hook validates each frame before
 *      yielding it (kill malformed UI state at the boundary).
 *
 * Adding a new topic = add an entry to `SOCKET_TOPIC_SCHEMAS` here +
 * the corresponding payload type. Both sides re-export through `@quant/shared`
 * so there is exactly one source of truth.
 */

import { z } from 'zod';

import { ChannelActivitySchema } from './channel.js';
import { QueueSnapshotSchema } from './queue-status.js';
import { WatchTaskSchema } from './watch.js';

/** Frame the gateway pushes to clients: `{ topic, ts, payload }`. */
export const SocketEnvelopeSchema = z
  .object({
    topic: z.string().min(1),
    ts: z.string().datetime({ offset: true }),
    payload: z.unknown(),
  })
  .strict();
export type SocketEnvelope = z.infer<typeof SocketEnvelopeSchema>;

/** Snapshot of all watch tasks (1Hz). Replaces the SSE `/api/watch/stream`. */
export const WatchSnapshotPayloadSchema = z.array(WatchTaskSchema);
export type WatchSnapshotPayload = z.infer<typeof WatchSnapshotPayloadSchema>;

/** Snapshot of the orchestration queues (1Hz). Replaces the SSE `/queue/stream`. */
export const QueueSnapshotPayloadSchema = QueueSnapshotSchema;
export type QueueSnapshotPayload = z.infer<typeof QueueSnapshotPayloadSchema>;

/** Channel activity row pushed in real time to the frontend feed. */
export const ChannelActivityPayloadSchema = ChannelActivitySchema;
export type ChannelActivityPayload = z.infer<typeof ChannelActivityPayloadSchema>;

/**
 * Single source of truth for the topic registry. Used by `SocketBus` to
 * validate emits and by `useSocketTopic` to validate inbound frames.
 *
 * Index signature is intentionally avoided (CLAUDE.md §1.2 forbids
 * `noPropertyAccessFromIndexSignature` violations); use the typed
 * `socketTopicSchema(name)` helper to look up a schema by topic id.
 */
export const SOCKET_TOPIC_SCHEMAS = {
  'watch.snapshot': WatchSnapshotPayloadSchema,
  'queue.snapshot': QueueSnapshotPayloadSchema,
  'channel.activity': ChannelActivityPayloadSchema,
} as const satisfies Readonly<Record<string, z.ZodTypeAny>>;

export type SocketTopic = keyof typeof SOCKET_TOPIC_SCHEMAS;

export type SocketTopicPayload<T extends SocketTopic> = z.infer<
  (typeof SOCKET_TOPIC_SCHEMAS)[T]
>;

export function socketTopicSchema<T extends SocketTopic>(
  topic: T,
): (typeof SOCKET_TOPIC_SCHEMAS)[T] {
  return SOCKET_TOPIC_SCHEMAS[topic];
}

/** Client → server subscription request. */
export const SocketSubscribeRequestSchema = z
  .object({
    topics: z.array(z.string().min(1)).min(1).max(64),
  })
  .strict();
export type SocketSubscribeRequest = z.infer<typeof SocketSubscribeRequestSchema>;

/**
 * Client → server command. Routed through the shared instruction
 * registry on the BE side: `id` matches a registered `InstructionSpec`
 * (e.g. `channel.send`, `ping`, `focus`, `screen`, ...). `args` is a
 * loose object validated against the spec's zod `argsSchema` after
 * dispatch.
 *
 * The registry is the single source of truth — adding a new socket
 * command no longer requires editing this schema.
 */
export const SocketCommandSchema = z
  .object({
    id: z.string().min(1).max(64),
    args: z.record(z.unknown()).default({}),
  })
  .strict();
export type SocketCommand = z.infer<typeof SocketCommandSchema>;

export const SocketCommandAckSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    detail: z.unknown().optional(),
  })
  .strict();
export type SocketCommandAck = z.infer<typeof SocketCommandAckSchema>;
