/**
 * Schemas for the SYS.PUSH test endpoint.
 *
 * Lets the frontend send a single ad-hoc message through the same
 * Slack-webhook adapter the watch scheduler uses. When no webhook is
 * configured, the server returns `{ ok: true, dryRun: true }` — the UI
 * surfaces this so the user can tell "delivered" from "logged only".
 */

import { z } from 'zod';

export const PushTestRequestSchema = z
  .object({
    channel: z
      .string()
      .regex(/^#?[a-zA-Z0-9_-]+$/, 'invalid channel')
      .optional(),
    payload: z.string().min(1).max(16000),
    note: z.string().max(280).optional(),
  })
  .strict();
export type PushTestRequest = z.infer<typeof PushTestRequestSchema>;

export const PushTestResponseSchema = z
  .object({
    ok: z.boolean(),
    dryRun: z.boolean(),
    deliveredAt: z.string(),
  })
  .strict();
export type PushTestResponse = z.infer<typeof PushTestResponseSchema>;
