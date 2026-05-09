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

import { AgentToolCallProposalSchema } from '../instructions/agent-tool-call.js';
import { InstructionResultSchema } from '../instructions/result.js';
import { ChannelActivitySchema } from './channel.js';
import { ChatTokenUsageSchema } from './llm.js';
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

/** Async instruction job entered the queue (`InstructionAsyncProcessor`). */
export const InstructionAsyncStartedPayloadSchema = z
  .object({
    jobId: z.string().min(1),
    instructionId: z.string().min(1),
    userId: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type InstructionAsyncStartedPayload = z.infer<typeof InstructionAsyncStartedPayloadSchema>;

/** Optional progress heartbeat from a long-running async instruction. */
export const InstructionAsyncProgressPayloadSchema = z
  .object({
    jobId: z.string().min(1),
    percent: z.number().min(0).max(100).optional(),
    message: z.string().max(280).optional(),
  })
  .strict();
export type InstructionAsyncProgressPayload = z.infer<typeof InstructionAsyncProgressPayloadSchema>;

/** Async instruction finished — carries the same `InstructionResult` shape as sync. */
export const InstructionAsyncCompletedPayloadSchema = z
  .object({
    jobId: z.string().min(1),
    instructionId: z.string().min(1),
    userId: z.string().min(1),
    result: InstructionResultSchema,
    finishedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type InstructionAsyncCompletedPayload = z.infer<
  typeof InstructionAsyncCompletedPayloadSchema
>;

/**
 * One frame in the `instruction.agent.delta` stream. The agent loop
 * (`apps/api/src/modules/agent/agent.service.ts`) emits these in order:
 *
 *   - `step`         — gray "▶ /focus 600519" line preceding each tool call
 *   - `tool_result`  — collapsible per-tool result for transparency
 *   - `confirm`      — pause: list of tool calls awaiting user approval
 *                       (term widget / Feishu button card)
 *   - `text`         — incremental delta of the streamed final answer
 *   - `done`         — closing frame with cumulative token usage + cost
 *
 * Frames are scoped per `jobId` so the FE / IM listener can route them
 * to the originating prompt (term scrollback row, IM thread).
 */
export const InstructionAgentDeltaPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('step'),
      jobId: z.string().min(1),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool_result'),
      jobId: z.string().min(1),
      toolId: z.string().min(1),
      ok: z.boolean(),
      summary: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('confirm'),
      jobId: z.string().min(1),
      correlationId: z.string().min(1),
      toolCalls: AgentToolCallProposalSchema.array().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      jobId: z.string().min(1),
      chunk: z.string(),
      done: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('done'),
      jobId: z.string().min(1),
      tokenUsage: ChatTokenUsageSchema,
      cnyCost: z.number().nonnegative(),
      toolCallCount: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type InstructionAgentDeltaPayload = z.infer<typeof InstructionAgentDeltaPayloadSchema>;

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
  'instruction.async.started': InstructionAsyncStartedPayloadSchema,
  'instruction.async.progress': InstructionAsyncProgressPayloadSchema,
  'instruction.async.completed': InstructionAsyncCompletedPayloadSchema,
  'instruction.agent.delta': InstructionAgentDeltaPayloadSchema,
} as const satisfies Readonly<Record<string, z.ZodTypeAny>>;

export type SocketTopic = keyof typeof SOCKET_TOPIC_SCHEMAS;

export type SocketTopicPayload<T extends SocketTopic> = z.infer<(typeof SOCKET_TOPIC_SCHEMAS)[T]>;

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
