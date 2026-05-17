/**
 * Module DI token + minimal local shape. The actual values live on
 * `ServerConfigCenter.get().llm.agentLoop`; the module factory adapts
 * that into this narrower contract for the legacy `AGENT_CONFIG`
 * consumers.
 */

export interface AgentConfig {
  /** Per-call cap when the caller doesn't supply one. */
  readonly defaultMaxToolCalls: number;
}

export const AGENT_CONFIG = Symbol('AGENT_CONFIG');
