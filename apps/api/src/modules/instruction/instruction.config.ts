/**
 * Module DI token + narrow shape consumed by services that
 * `@Inject(INSTRUCTION_CONFIG)`. The factory in `instruction.module.ts`
 * lifts the relevant slice off `ServerConfigCenter.get().instruction`.
 */

export const INSTRUCTION_CONFIG = Symbol('INSTRUCTION_CONFIG');

export interface InstructionConfig {
  readonly imAllowlist: ReadonlySet<string>;
  readonly debugInstructionsEnabled: boolean;
}
