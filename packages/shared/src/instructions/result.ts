/**
 * Cross-process instruction result. Both the BE IM listener (which
 * formats this into a Slack/Feishu reply) and any future FE-side
 * delegating handler (toast / banner) consume the same shape.
 */

export type InstructionErrorCode =
  | 'parse'
  | 'validation'
  | 'not-found'
  | 'forbidden'
  | 'handler';

export interface InstructionOutput {
  readonly text: string;
}

export interface InstructionError {
  readonly code: InstructionErrorCode;
  readonly message: string;
}

export type InstructionResult =
  | { readonly ok: true; readonly output: InstructionOutput }
  | { readonly ok: false; readonly error: InstructionError };

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
