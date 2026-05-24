/**
 * Provider catalog — design-time data describing the OpenAI-compatible
 * endpoints we know how to talk to. Each row pins:
 *
 *   - which models the provider exposes (`modelPro` / `modelFlash`)
 *   - whether the pro tier supports web search natively, and which on-the-
 *     wire convention (Moonshot tool-loop vs Qwen extra_body)
 *   - the OpenAI-compatible base URL
 *   - the env variable name carrying the API key (always the only secret)
 *   - per-1k-token CNY price for input / output (used by the user ledger)
 *
 * Resolution priority used by `LlmService.resolve*`:
 *
 *   1. caller-supplied override `provider` (when non-empty) → that row,
 *      provided its API key is set.
 *   2. need-web-search → first row with `webSearchKind` set + key in env,
 *      use `modelPro`.
 *   3. otherwise → first row with key in env, use `modelPro`.
 *
 * Catalog order is the user-visible default priority. Mirrors the Python
 * `LLM_PROVIDERS` table this module replaces.
 */

export type WebSearchKind = 'moonshot_tool' | 'qwen_extra_body' | 'qwen_responses';

export interface LlmProviderRow {
  /** Stable identifier (lower-case). Used in logs and the user ledger. */
  readonly provider: string;
  /** High-quality model — default for tool-use / DSL translation. */
  readonly modelPro: string;
  /** Cheap / fast model — optional. Skipped under `useFlash=true` when unset. */
  readonly modelFlash?: string;
  /** OpenAI-compatible base URL. */
  readonly baseUrl: string;
  /** Env variable name carrying the API key. */
  readonly apiKeyEnv: string;
  /** When set, indicates the pro tier exposes a web-search backend. */
  readonly webSearchKind?: WebSearchKind;
  /** CNY per 1_000 input tokens. */
  readonly cnyPerKInputToken: number;
  /** CNY per 1_000 output tokens. */
  readonly cnyPerKOutputToken: number;
}

/**
 * Priority-ordered catalog. Prices reflect 2026-Q2 published rates;
 * adjust here when vendors update their pricing — the ledger picks up
 * the new numbers automatically on next call.
 *
 * Ordering policy:
 *   - **Deepseek first** so the no-override default (`/screen` NL→DSL,
 *     `/ta`, JSON-mode aggregator, agent loop without `AGENT_LLM_*`)
 *     lands on Deepseek — cheapest and good enough for tool-use.
 *   - **Qwen next** so the web-search filter (`webSearchKind !==
 *     undefined`) picks Qwen first when a caller asks for native search
 *     (`/analyze`'s analyst pass, `/agent web.search`). Deepseek has no
 *     web-search backend, so it's skipped automatically by that filter.
 *   - **Moonshot last** as the fallback web-search provider.
 */
export const LLM_PROVIDERS: readonly LlmProviderRow[] = [
  {
    provider: 'deepseek',
    modelPro: 'deepseek-v4-pro',
    modelFlash: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    cnyPerKInputToken: 0.001,
    cnyPerKOutputToken: 0.002,
  },
  {
    provider: 'qwen',
    modelPro: 'qwen3.6-plus-2026-04-02',
    modelFlash: 'qwen-turbo',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'QWEN_API_KEY',
    webSearchKind: 'qwen_responses',
    cnyPerKInputToken: 0.0008,
    cnyPerKOutputToken: 0.002,
  },
  {
    provider: 'moonshot',
    modelPro: 'kimi-k2.6',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    webSearchKind: 'moonshot_tool',
    cnyPerKInputToken: 0.012,
    cnyPerKOutputToken: 0.012,
  },
] as const;

export function findProviderRow(name: string): LlmProviderRow | undefined {
  return LLM_PROVIDERS.find((p) => p.provider === name);
}

export function knownProviderNames(): readonly string[] {
  return LLM_PROVIDERS.map((p) => p.provider);
}

/** CNY cost for one call, given the row + token usage. Rounded to 4 decimals. */
export function priceCallCny(
  row: LlmProviderRow,
  usage: { input: number; output: number },
): number {
  const inputCny = (usage.input / 1000) * row.cnyPerKInputToken;
  const outputCny = (usage.output / 1000) * row.cnyPerKOutputToken;
  return Math.round((inputCny + outputCny) * 10_000) / 10_000;
}
