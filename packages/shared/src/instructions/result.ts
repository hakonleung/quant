/**
 * Cross-process instruction result. Both the BE IM listener (which
 * formats this into a Slack/Feishu reply) and any future FE-side
 * delegating handler (toast / banner) consume the same shape.
 */

import { z } from 'zod';

export const InstructionErrorCodeSchema = z.enum([
  'parse',
  'validation',
  'not-found',
  'forbidden',
  'handler',
  /**
   * Soft-failure: the instruction needs the user's interactive
   * approval before it will run. The IM listener / FE term render this
   * as a button card / confirm widget rather than a red error. The
   * `error.message` field carries a JSON envelope with the data the
   * UI needs to mount the confirm surface (e.g. the original `q`).
   */
  'confirm-required',
]);
export type InstructionErrorCode = z.infer<typeof InstructionErrorCodeSchema>;

export const InstructionOutputSchema = z
  .object({
    text: z.string(),
  })
  .strict();
export type InstructionOutput = z.infer<typeof InstructionOutputSchema>;

export const InstructionErrorSchema = z
  .object({
    code: InstructionErrorCodeSchema,
    message: z.string(),
  })
  .strict();
export type InstructionError = z.infer<typeof InstructionErrorSchema>;

export const InstructionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), output: InstructionOutputSchema }).strict(),
  z.object({ ok: z.literal(false), error: InstructionErrorSchema }).strict(),
]);
export type InstructionResult = z.infer<typeof InstructionResultSchema>;

export function okResult(text: string): InstructionResult {
  return { ok: true, output: { text } };
}

export function errResult(code: InstructionErrorCode, message: string): InstructionResult {
  return { ok: false, error: { code, message } };
}

/** Plain-text rendering shared by IM reply and FE toast. */
export function formatResult(r: InstructionResult): string {
  if (r.ok) return r.output.text;
  return `[${r.error.code}] ${r.error.message}`;
}
