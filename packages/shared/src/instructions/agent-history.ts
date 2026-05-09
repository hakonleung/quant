/**
 * Cross-process schema for the per-conversation history feed the
 * `/agent` instruction injects into the LLM prompt:
 *
 *   - **Term** collects the last few `PromptEntry` + `OutputEntry`s
 *     from the local terminal state and sends them along the socket
 *     command.
 *   - **IM (Feishu)** maintains a per `(userId, channel)` ring buffer
 *     in `AgentHistoryStore` and injects the recent slice when the
 *     instruction handler runs.
 *
 * The shape is deliberately minimal — `role` + `content` + `ts` —
 * because the agent loop converts entries to `ChatMessage` directly
 * (`role: 'user' | 'assistant' | 'tool'`, `content: string`).
 */

import { z } from 'zod';

export const AgentHistoryRoleSchema = z.enum(['user', 'assistant', 'tool']);
export type AgentHistoryRole = z.infer<typeof AgentHistoryRoleSchema>;

export const AgentHistoryEntrySchema = z
  .object({
    role: AgentHistoryRoleSchema,
    content: z.string(),
    /** ISO-8601 with offset; used for ring-buffer ordering, not surfaced in the prompt. */
    ts: z.string().datetime({ offset: true }),
  })
  .strict();
export type AgentHistoryEntry = z.infer<typeof AgentHistoryEntrySchema>;

/** Compile-time cap on the slice the term/IM caller may pass. */
export const AGENT_HISTORY_MAX_ENTRIES = 20;
