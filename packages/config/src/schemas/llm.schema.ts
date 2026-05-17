/**
 * LLM client tuning.
 *
 * `default` + `agent` capture provider/model overrides — these are the
 * only env-driven fields; everything else is hardcoded here so the
 * package stays env-agnostic. Callers pass the already-parsed shape
 * via {@link llmConfig}; defaults fill any missing slot.
 */

export interface LlmProviderOverride {
  readonly provider?: string;
  readonly model?: string;
}

export interface LlmWebSearchConfig {
  readonly turnTimeoutMs: number;
  readonly maxRounds: number;
  readonly streamChunkChars: number;
}

export interface LlmAgentConfig {
  readonly defaultMaxToolCalls: number;
}

export interface LlmConfig {
  readonly default: LlmProviderOverride;
  readonly agent: LlmProviderOverride;
  readonly requestTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly webSearch: LlmWebSearchConfig;
  readonly agentLoop: LlmAgentConfig;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  default: {},
  agent: {},
  requestTimeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  webSearch: {
    turnTimeoutMs: 240_000,
    maxRounds: 1,
    streamChunkChars: 64,
  },
  agentLoop: {
    defaultMaxToolCalls: 5,
  },
};

export interface LlmConfigOverrides {
  readonly default?: LlmProviderOverride;
  readonly agent?: LlmProviderOverride;
  readonly requestTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly webSearch?: Partial<LlmWebSearchConfig>;
  readonly agentLoop?: Partial<LlmAgentConfig>;
}

export function llmConfig(overrides: LlmConfigOverrides = {}): LlmConfig {
  return {
    ...DEFAULT_LLM_CONFIG,
    ...overrides,
    webSearch: { ...DEFAULT_LLM_CONFIG.webSearch, ...(overrides.webSearch ?? {}) },
    agentLoop: { ...DEFAULT_LLM_CONFIG.agentLoop, ...(overrides.agentLoop ?? {}) },
  };
}
