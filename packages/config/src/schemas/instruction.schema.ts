/**
 * Instruction registry (IM allowlist + async queue tuning).
 */

export interface InstructionAsyncConfig {
  readonly attempts: number;
  readonly removeOnComplete: number;
  readonly removeOnFail: number;
}

export interface InstructionConfig {
  readonly imAllowlist: ReadonlySet<string>;
  readonly debugInstructionsEnabled: boolean;
  readonly async: InstructionAsyncConfig;
}

export const DEFAULT_INSTRUCTION_ASYNC_CONFIG: InstructionAsyncConfig = {
  attempts: 1,
  removeOnComplete: 50,
  removeOnFail: 100,
};

export const DEFAULT_INSTRUCTION_CONFIG: InstructionConfig = {
  imAllowlist: new Set<string>(),
  debugInstructionsEnabled: false,
  async: DEFAULT_INSTRUCTION_ASYNC_CONFIG,
};

export interface InstructionConfigOverrides {
  readonly imAllowlist?: ReadonlySet<string>;
  readonly debugInstructionsEnabled?: boolean;
  readonly async?: Partial<InstructionAsyncConfig>;
}

export function instructionConfig(
  overrides: InstructionConfigOverrides = {},
): InstructionConfig {
  return {
    ...DEFAULT_INSTRUCTION_CONFIG,
    ...overrides,
    async: { ...DEFAULT_INSTRUCTION_ASYNC_CONFIG, ...(overrides.async ?? {}) },
  };
}
