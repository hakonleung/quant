/**
 * Per-user LLM ledger snapshot persisted at
 * `data/users/{userId}/user_llm_ledger.parquet` (single payload_json row).
 *
 * Append-only — every LLM call lands in `entries`. Truncation is a v2
 * concern. `/usr` aggregates on read.
 *
 * v2 schema drops `provider`, `cnyCost`, and the never-stored `total`.
 * Provider can be derived from `model` via the live catalog when needed;
 * cost reporting was removed entirely. Legacy v1 files are stripped on
 * read by `UserLlmLedgerStore.loadSnap`.
 */

import { z } from 'zod';

import { ChatTokenUsageSchema, LlmScopeSchema } from '@quant/shared';

export const UserLlmLedgerEntrySchema = z
  .object({
    /** ISO-8601 with offset, generated from the system clock. */
    ts: z.string().datetime({ offset: true }),
    /** Model name actually used (e.g. `kimi-k2.6`). */
    model: z.string().min(1),
    /** Domain scope tag — used by `/usr` to break usage out per feature. */
    scope: LlmScopeSchema,
    /** Token counts; usage may be empty/zero on failed calls. */
    usage: ChatTokenUsageSchema,
    /** Wall-clock duration of the call in milliseconds. */
    durationMs: z.number().int().nonnegative(),
    /** `true` when the call returned successfully. Failed calls still get logged. */
    ok: z.boolean(),
    /** Trace id threaded through the request — for cross-process correlation. */
    traceId: z.string().min(1),
  })
  .strict();
export type UserLlmLedgerEntry = z.infer<typeof UserLlmLedgerEntrySchema>;

export const USER_LLM_LEDGER_SCHEMA_VERSION = 2 as const;

export const UserLlmLedgerSchema = z
  .object({
    schemaVersion: z.literal(USER_LLM_LEDGER_SCHEMA_VERSION),
    entries: UserLlmLedgerEntrySchema.array(),
  })
  .strict();
export type UserLlmLedger = z.infer<typeof UserLlmLedgerSchema>;

export const EMPTY_USER_LLM_LEDGER: UserLlmLedger = {
  schemaVersion: USER_LLM_LEDGER_SCHEMA_VERSION,
  entries: [],
};

/**
 * Convert a possibly-legacy v1 payload to v2 by stripping `provider` /
 * `cnyCost` from each entry. Returns `null` if the input does not look
 * like a recognizable ledger payload (caller falls back to empty).
 */
export function migrateLedgerPayload(raw: unknown): UserLlmLedger | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as { schemaVersion?: unknown; entries?: unknown };
  if (!Array.isArray(obj.entries)) return null;
  const cleanedEntries: UserLlmLedgerEntry[] = [];
  for (const e of obj.entries) {
    if (e === null || typeof e !== 'object') continue;
    const src = e as Record<string, unknown>;
    const candidate = {
      ts: src['ts'],
      model: src['model'],
      scope: src['scope'],
      usage: src['usage'],
      durationMs: src['durationMs'],
      ok: src['ok'],
      traceId: src['traceId'],
    };
    const parsed = UserLlmLedgerEntrySchema.safeParse(candidate);
    if (parsed.success) cleanedEntries.push(parsed.data);
  }
  return { schemaVersion: USER_LLM_LEDGER_SCHEMA_VERSION, entries: cleanedEntries };
}
