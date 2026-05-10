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
    /**
     * Optional structured side-channel for renderers that can do better
     * than plain text — e.g. the Feishu adapter switches to a native
     * `table` element when `meta.stockTableRows` is set instead of
     * falling back to ASCII column padding inside `lark_md`. Term and
     * Slack consumers ignore it and still render `text`.
     *
     * Free-form `Record<string, unknown>`: schemas live with the
     * specific renderers (kept here as `unknown` so `@quant/shared`
     * doesn't take on Feishu-specific dependencies).
     */
    meta: z.record(z.unknown()).optional(),
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

/**
 * `okResult` with an extra structured payload. Renderers that understand
 * the keys (today: only the Feishu adapter, for `stockTableRows`) use
 * them to render richer surfaces; others fall back to `text`.
 */
export function okResultWithMeta(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): InstructionResult {
  return { ok: true, output: { text, meta } };
}

export function errResult(code: InstructionErrorCode, message: string): InstructionResult {
  return { ok: false, error: { code, message } };
}

/** Plain-text rendering shared by IM reply and FE toast. */
export function formatResult(r: InstructionResult): string {
  if (r.ok) return r.output.text;
  return `[${r.error.code}] ${r.error.message}`;
}
