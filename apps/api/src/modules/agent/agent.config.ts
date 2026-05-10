/**
 * `/agent` runtime config — resolved once at module init from env so
 * the service never reads `process.env` itself (CLAUDE.md §2.5.1: env
 * lives only at the config layer).
 *
 * Today only one knob: `defaultMaxToolCalls`. Lifted out of
 * `AgentService.resolveMaxToolCalls` so a future operator-facing
 * setting (`/sys.cfg agent.max=…`) can mutate it without touching the
 * service surface.
 */

import { clampInt, DEFAULT_MAX_TOOL_CALLS, parseInteger } from './agent-helpers.js';

export interface AgentConfig {
  /** Per-call cap when the caller doesn't supply one. Clamped to
   *  `[MIN_MAX_TOOL_CALLS, HARD_MAX_TOOL_CALLS]` per `clampInt`. */
  readonly defaultMaxToolCalls: number;
}

export const AGENT_CONFIG = Symbol('AGENT_CONFIG');

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const raw = env['AGENT_MAX_TOOL_CALLS'];
  return {
    defaultMaxToolCalls: clampInt(parseInteger(raw), DEFAULT_MAX_TOOL_CALLS),
  };
}
