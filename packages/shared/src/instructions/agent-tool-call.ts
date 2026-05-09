/**
 * Cross-process schema for an `/agent` tool-call proposal.
 *
 * When the LLM emits a `tool_calls` round inside the agent loop, each
 * proposed call is converted to this shape and either:
 *   - executed immediately (read-only tools), OR
 *   - presented to the user for confirmation (`costsCredits` /
 *     `destructive` tools) via the `instruction.agent.delta` socket
 *     `confirm` frame, term widget, or Feishu button card.
 *
 * Args are passed as a `Record<string, unknown>` because the eventual
 * receiver is `InstructionExecutor.execute(id, args, ctx)`, which runs
 * the args through the target instruction's zod `argsSchema` itself.
 */

import { z } from 'zod';

import { INSTRUCTION_ID_RE } from './id.js';

export const AgentToolCallProposalSchema = z
  .object({
    id: z.string().regex(INSTRUCTION_ID_RE, 'invalid instruction id'),
    args: z.record(z.unknown()),
    /** One-line summary the UI shows to the user — usually the spec's `summary`. */
    summary: z.string(),
  })
  .strict();
export type AgentToolCallProposal = z.infer<typeof AgentToolCallProposalSchema>;
