/**
 * Module-local config for the NestJS LLM client.
 *
 * Two-layer override:
 *   - `LLM_*`        — default provider used by every consumer
 *                      (`/screen` NL→DSL, `/analyze`, future agent loop).
 *   - `AGENT_LLM_*`  — optional override applied only when a consumer asks
 *                      for the "agent" scope. Lets us pin `/agent` to a
 *                      web-search-capable provider (Kimi / Qwen) without
 *                      moving the cheaper default off Deepseek.
 *
 * The provider catalog (which models exist, which support web search,
 * what the OpenAI-compatible base URL is, which env var carries the API
 * key) lives in `providers.ts`. **API keys come from the per-provider
 * `*_API_KEY` envs** the catalog already declares — we deliberately do
 * NOT re-expose them via `LLM_API_KEY` etc. The only knobs here are:
 *
 *   - `LLM_PROVIDER` / `AGENT_LLM_PROVIDER`  — pin a catalog row
 *   - `LLM_MODEL`    / `AGENT_LLM_MODEL`     — override `model_pro`
 *   - `LLM_REQUEST_TIMEOUT_MS`               — operational tuning
 *
 * For "I want to talk to a totally bespoke OpenAI-compatible endpoint
 * that isn't in the catalog" the right answer is to add a row in
 * `providers.ts`, not invent a parallel env hatch.
 */

import { z } from 'zod';

export const LLM_CONFIG = Symbol('LLM_CONFIG');

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

const numberFromEnv = (raw: string | undefined, fallback: number, key: string): number => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid integer for ${key}: ${raw}`);
  }
  if (parsed > MAX_TIMEOUT_MS) {
    throw new Error(`${key}=${raw} exceeds max ${MAX_TIMEOUT_MS}ms`);
  }
  return parsed;
};

const rawSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    agentProvider: z.string().optional(),
    agentModel: z.string().optional(),
  })
  .strict();

/**
 * Resolved per-scope override. Both fields optional: missing fields fall
 * back to the catalog row's defaults.
 */
export interface LlmProviderOverride {
  readonly provider?: string;
  readonly model?: string;
}

export interface LlmConfig {
  /** Default provider override; empty = "pick first catalog row with key in env". */
  readonly default: LlmProviderOverride;
  /** Optional `/agent` override; falls back to `default` when fields are absent. */
  readonly agent: LlmProviderOverride;
  /** Per-call HTTP timeout. */
  readonly requestTimeoutMs: number;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const parsed = rawSchema.parse({
    provider: env['LLM_PROVIDER'],
    model: env['LLM_MODEL'],
    requestTimeoutMs:
      env['LLM_REQUEST_TIMEOUT_MS'] === undefined
        ? undefined
        : numberFromEnv(
            env['LLM_REQUEST_TIMEOUT_MS'],
            DEFAULT_TIMEOUT_MS,
            'LLM_REQUEST_TIMEOUT_MS',
          ),
    agentProvider: env['AGENT_LLM_PROVIDER'],
    agentModel: env['AGENT_LLM_MODEL'],
  });
  return {
    default: buildOverride({ provider: parsed.provider, model: parsed.model }),
    agent: buildOverride({ provider: parsed.agentProvider, model: parsed.agentModel }),
    requestTimeoutMs: parsed.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function buildOverride(raw: {
  provider: string | undefined;
  model: string | undefined;
}): LlmProviderOverride {
  const out: { -readonly [K in keyof LlmProviderOverride]: LlmProviderOverride[K] } = {};
  if (nonEmpty(raw.provider)) out.provider = raw.provider;
  if (nonEmpty(raw.model)) out.model = raw.model;
  return out;
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}
