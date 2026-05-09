/**
 * Module-local config for the NestJS LLM client.
 *
 * Two layers:
 *   - `LLM_*`        — default provider used by every consumer
 *                      (`/screen` NL→DSL, `/analyze`, future agent loop).
 *   - `AGENT_LLM_*`  — optional override applied only when a consumer asks
 *                      for the "agent" scope. Lets us pin `/agent` to a
 *                      web-search-capable provider (Kimi / Qwen) without
 *                      moving the cheaper default off Deepseek.
 *
 * The provider catalog (which models exist, which support web search,
 * what the OpenAI-compatible base URL is) is design-time data and lives
 * in `providers.ts`; only the API key + per-deploy overrides come from
 * env. Mirrors the Python convention this module replaces.
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
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    agentProvider: z.string().optional(),
    agentApiKey: z.string().optional(),
    agentBaseUrl: z.string().optional(),
    agentModel: z.string().optional(),
    agentWebSearchKind: z.enum(['moonshot_tool', 'qwen_extra_body']).optional(),
  })
  .strict();

/**
 * One resolved provider override. `provider` is the catalog key (e.g.
 * `moonshot`, `qwen`, `deepseek`); when both `apiKey` and `baseUrl` are
 * set, the catalog row's defaults are bypassed and the call goes to the
 * caller-supplied endpoint instead.
 */
export interface LlmProviderOverride {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly webSearchKind?: 'moonshot_tool' | 'qwen_extra_body';
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
    apiKey: env['LLM_API_KEY'],
    baseUrl: env['LLM_BASE_URL'],
    model: env['LLM_MODEL'],
    requestTimeoutMs:
      env['LLM_REQUEST_TIMEOUT_MS'] === undefined
        ? undefined
        : numberFromEnv(env['LLM_REQUEST_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS, 'LLM_REQUEST_TIMEOUT_MS'),
    agentProvider: env['AGENT_LLM_PROVIDER'],
    agentApiKey: env['AGENT_LLM_API_KEY'],
    agentBaseUrl: env['AGENT_LLM_BASE_URL'],
    agentModel: env['AGENT_LLM_MODEL'],
    agentWebSearchKind: env['AGENT_LLM_WEB_SEARCH_KIND'] as
      | 'moonshot_tool'
      | 'qwen_extra_body'
      | undefined,
  });
  return {
    default: buildOverride({
      provider: parsed.provider,
      apiKey: parsed.apiKey,
      baseUrl: parsed.baseUrl,
      model: parsed.model,
    }),
    agent: buildOverride({
      provider: parsed.agentProvider,
      apiKey: parsed.agentApiKey,
      baseUrl: parsed.agentBaseUrl,
      model: parsed.agentModel,
      webSearchKind: parsed.agentWebSearchKind,
    }),
    requestTimeoutMs: parsed.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function buildOverride(raw: {
  provider: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  webSearchKind?: 'moonshot_tool' | 'qwen_extra_body' | undefined;
}): LlmProviderOverride {
  const out: { -readonly [K in keyof LlmProviderOverride]: LlmProviderOverride[K] } = {};
  if (nonEmpty(raw.provider)) out.provider = raw.provider;
  if (nonEmpty(raw.apiKey)) out.apiKey = raw.apiKey;
  if (nonEmpty(raw.baseUrl)) out.baseUrl = raw.baseUrl;
  if (nonEmpty(raw.model)) out.model = raw.model;
  if (raw.webSearchKind !== undefined) out.webSearchKind = raw.webSearchKind;
  return out;
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}
