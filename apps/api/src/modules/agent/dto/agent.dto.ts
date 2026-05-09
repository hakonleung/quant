/**
 * DTO + arg schemas for the `/agent` and `/agent.confirm` instructions.
 *
 * `q`            — the user's natural-language prompt (≤ 2k chars).
 * `confirm`      — present + truthy when the term widget / Feishu
 *                  callback has confirmed the up-front paid call.
 * `context`      — optional explicit history slice (term passes its
 *                  recent prompt + output entries; IM falls back to
 *                  AgentHistoryStore when omitted).
 * `maxToolCalls` — per-call cap, defaulting to env / 5 / clamp 1..10.
 * `correlationId`+ `approve` (`agent.confirm` only) — handed back from
 *                  the confirm card; `approve=false` ends the loop.
 */

import { AgentHistoryEntrySchema, AGENT_HISTORY_MAX_ENTRIES } from '@quant/shared';
import { z } from 'zod';

const TRUTHY = new Set(['1', 'true', 'TRUE', 'yes', 'on']);
const FALSY = new Set(['', '0', 'false', 'FALSE', 'no', 'off']);

const flexibleBool = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
    throw new Error(`invalid boolean: ${v}`);
  });

export const AgentArgsSchema = z
  .object({
    q: z.string().min(1).max(2000),
    confirm: flexibleBool.optional(),
    context: AgentHistoryEntrySchema.array().max(AGENT_HISTORY_MAX_ENTRIES).optional(),
    maxToolCalls: z.union([z.number(), z.string()]).optional(),
  })
  .strict();
export type AgentArgs = z.infer<typeof AgentArgsSchema>;

export const AgentConfirmArgsSchema = z
  .object({
    correlationId: z.string().min(1),
    approve: flexibleBool,
  })
  .strict();
export type AgentConfirmArgs = z.infer<typeof AgentConfirmArgsSchema>;
