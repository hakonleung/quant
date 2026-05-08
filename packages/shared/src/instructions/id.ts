/**
 * Instruction id naming. Single source of truth for both the FE
 * `@quant/terminal` registry (single-segment names like `focus`) and the
 * BE `apps/api/src/modules/instruction` registry (which also uses
 * dotted names like `channel.echo`).
 *
 * Branding catches "string accidentally fed to executor.execute" in
 * type-check, without forcing every call site through a runtime checker.
 */

export type InstructionId = string & { readonly __brand: 'InstructionId' };

export const INSTRUCTION_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/u;

export class InvalidInstructionIdError extends Error {
  constructor(readonly raw: string) {
    super(`invalid instruction id: ${raw}`);
    this.name = 'InvalidInstructionIdError';
  }
}

export function instructionId(raw: string): InstructionId {
  if (!INSTRUCTION_ID_RE.test(raw)) throw new InvalidInstructionIdError(raw);
  return raw as InstructionId;
}

export function isInstructionId(raw: string): raw is InstructionId {
  return INSTRUCTION_ID_RE.test(raw);
}
