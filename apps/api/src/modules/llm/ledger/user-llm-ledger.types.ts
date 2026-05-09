/**
 * Shape of the per-user LLM ledger snapshot persisted at
 * `data/users/{userId}/llm-ledger.json`.
 *
 * Append-only — every LLM call lands in `entries`. Truncation is a v2
 * concern; for now the file just grows. `/usr` aggregates on read so we
 * don't need running counters in the snapshot.
 */

import { z } from 'zod';

import { ChatTokenUsageSchema, LlmScopeSchema } from '@quant/shared';

export const UserLlmLedgerEntrySchema = z
  .object({
    /** ISO-8601 with offset, generated from the system clock. */
    ts: z.string().datetime({ offset: true }),
    /** Catalog provider id (e.g. `moonshot`, `qwen`). */
    provider: z.string().min(1),
    /** Model name actually used (e.g. `kimi-k2.6`). */
    model: z.string().min(1),
    /** Domain scope tag — used by `/usr` to break spend out per feature. */
    scope: LlmScopeSchema,
    /** Token counts; usage may be empty/zero on failed calls. */
    usage: ChatTokenUsageSchema,
    /** CNY cost for this single call (input + output), rounded to 4 decimals. */
    cnyCost: z.number().nonnegative(),
    /** Wall-clock duration of the call in milliseconds. */
    durationMs: z.number().int().nonnegative(),
    /** `true` when the call returned successfully. Failed calls still get logged. */
    ok: z.boolean(),
    /** Trace id threaded through the request — for cross-process correlation. */
    traceId: z.string().min(1),
  })
  .strict();
export type UserLlmLedgerEntry = z.infer<typeof UserLlmLedgerEntrySchema>;

export const UserLlmLedgerSchema = z
  .object({
    /** Schema version; bump on incompatible shape changes. */
    schemaVersion: z.literal(1),
    entries: UserLlmLedgerEntrySchema.array(),
  })
  .strict();
export type UserLlmLedger = z.infer<typeof UserLlmLedgerSchema>;

export const EMPTY_USER_LLM_LEDGER: UserLlmLedger = {
  schemaVersion: 1,
  entries: [],
};
