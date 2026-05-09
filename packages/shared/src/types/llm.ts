/**
 * Cross-process contract for the NestJS LLM client (OpenAI-compatible).
 *
 * These primitives mirror the OpenAI chat-completion API surface that every
 * provider we support (DeepSeek / Moonshot / Qwen / Doubao / OpenAI) speaks
 * over the wire. They are shared between:
 *   - `apps/api/src/modules/llm/*` (the producer / SDK adapter side)
 *   - `apps/api/src/modules/agent/*` (the multi-step agent loop)
 *   - any feature service migrating off the old Python LLM client
 *     (`/screen` NL→DSL, `/analyze` ledger review, future consumers)
 *
 * Naming: `Chat*` is intentionally retained even though the bigger feature
 * is renamed `/agent` — these schemas are 1:1 with the chat-completion API,
 * not with our agent loop, so the OpenAI naming stays.
 */

import { z } from 'zod';

/** A single tool call the model wants the host to execute. */
export const ChatToolCallSchema = z
  .object({
    /** Provider-issued id used to thread the matching `role:'tool'` reply. */
    id: z.string().min(1),
    /** Our internal instruction id (e.g. `focus`, `screen`). */
    toolId: z.string().min(1),
    /** Tool args — already JSON-decoded by the SDK adapter. */
    args: z.record(z.unknown()),
  })
  .strict();
export type ChatToolCall = z.infer<typeof ChatToolCallSchema>;

/**
 * Chat-completion message envelope. We keep the four roles OpenAI defines.
 * `assistant` may carry both content (final or streaming text) and zero or
 * more `toolCalls`; `tool` always pairs with a previous `assistant.toolCalls`
 * entry via `toolCallId`.
 */
export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string(),
      toolCalls: ChatToolCallSchema.array().optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      toolCallId: z.string().min(1),
      content: z.string(),
    })
    .strict(),
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * One tool the host exposes to the model. `schema` is a JSON-Schema (object)
 * derived from the instruction's zod arg schema; the SDK adapter passes it
 * straight to OpenAI's `tools[].function.parameters`.
 */
export const ChatToolSchema = z
  .object({
    /** Stable, snake_case-or-dotted identifier. Echoed back as `toolCall.toolId`. */
    id: z.string().min(1),
    /** One-line description shown to the model in the tool-listing. */
    description: z.string().min(1),
    /** JSON-schema object describing the tool's input args. */
    schema: z.record(z.unknown()),
  })
  .strict();
export type ChatTool = z.infer<typeof ChatToolSchema>;

/** Per-call token accounting. Input + output sums to `total` for every provider we use. */
export const ChatTokenUsageSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type ChatTokenUsage = z.infer<typeof ChatTokenUsageSchema>;

export const ChatFinishReasonSchema = z.enum([
  'stop',
  'tool_calls',
  'length',
  'content_filter',
]);
export type ChatFinishReason = z.infer<typeof ChatFinishReasonSchema>;

/**
 * One non-streaming round of `chat_with_tools`. The agent loop reads
 * `toolCalls` first; if empty, it switches into the streaming finalize
 * channel using `content` as a seed message.
 */
export const ChatStepResultSchema = z
  .object({
    content: z.string().nullable(),
    toolCalls: ChatToolCallSchema.array(),
    usage: ChatTokenUsageSchema,
    finishReason: ChatFinishReasonSchema,
  })
  .strict();
export type ChatStepResult = z.infer<typeof ChatStepResultSchema>;

/**
 * One frame yielded by the streaming finalize iterator. `delta` is the
 * incremental text chunk; the final frame carries `done=true` and the
 * cumulative `usage` that just landed in the `[DONE]` event from the
 * provider.
 */
export const ChatStreamChunkSchema = z
  .object({
    delta: z.string(),
    done: z.boolean(),
    usage: ChatTokenUsageSchema.optional(),
  })
  .strict();
export type ChatStreamChunk = z.infer<typeof ChatStreamChunkSchema>;

/**
 * Domain scope tag attached to every LLM call. Used by the user ledger to
 * separate `/agent` cost from `/screen` and `/analyze`, and by the logger
 * to surface per-feature spend.
 */
export const LlmScopeSchema = z.enum([
  'agent',
  'screen',
  'analyze',
  'sentiment',
  'ta',
  'other',
]);
export type LlmScope = z.infer<typeof LlmScopeSchema>;
