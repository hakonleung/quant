/**
 * High-level LLM entry point — every consumer (`/screen` NL→DSL,
 * `/analyze` ledger review, future agent loop) calls through here.
 *
 * Responsibilities:
 *   - Resolve a provider (default vs agent scope) by combining the
 *     `LLM_*` / `AGENT_LLM_*` env config with the static `LLM_PROVIDERS`
 *     catalog.
 *   - Construct (and cache) the OpenAI-compatible adapter per resolved
 *     row.
 *   - Wrap every call so we record token usage to the user ledger
 *     (`UserLlmLedgerStore`) and emit a structured log line per
 *     CLAUDE.md §1.4.
 *   - Surface a stable surface (`chatWithTools` / `chatStreamFinalize` /
 *     `completeJson`) that does not change as the underlying SDK evolves.
 *
 * Resolution rules (mirrored from Python):
 *   1. If the caller passes `scope: 'agent'` AND `LlmConfig.agent` has a
 *      provider+apiKey override → use that.
 *   2. Else if `LlmConfig.default.provider` is set AND its catalog key
 *      env is populated → that row.
 *   3. Else (`need_web_search=true`) → first catalog row with
 *      `webSearchKind` and key in env.
 *   4. Else → first catalog row with key in env.
 *   5. Else → throw `LLM_FAILED no_provider`.
 *
 * The user ledger always gets written on resolved calls (success and
 * failure), so `/usr` totals reflect actual spend regardless of outcome.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  type ChatMessage,
  type ChatStepResult,
  type ChatStreamChunk,
  type ChatTokenUsage,
  type ChatTool,
  type LlmScope,
  QuantError,
} from '@quant/shared';

import { OpenAiCompatibleLlmClient } from './adapters/openai-compatible.client.js';
import { LlmLedgerRecorder } from './ledger/llm-ledger.recorder.js';
import { LLM_CONFIG, type LlmConfig, type LlmProviderOverride } from './llm.config.js';
import {
  findProviderRow,
  LLM_PROVIDERS,
  type LlmProviderRow,
  type WebSearchKind,
} from './providers.js';

const ZERO_USAGE: ChatTokenUsage = { input: 0, output: 0, total: 0 };

interface ResolvedProvider {
  readonly row: LlmProviderRow;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly webSearchKind: WebSearchKind | undefined;
}

export interface ResolveOptions {
  /** Domain scope — `'agent'` honours the AGENT_LLM_* override. */
  readonly scope: LlmScope;
  /** When true, prefer a provider with `webSearchKind`. */
  readonly needWebSearch?: boolean;
}

export interface LlmCallContext {
  readonly userId: string;
  readonly traceId: string;
  readonly scope: LlmScope;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly clientCache = new Map<string, OpenAiCompatibleLlmClient>();

  constructor(
    @Inject(LLM_CONFIG) private readonly cfg: LlmConfig,
    @Inject(LlmLedgerRecorder) private readonly recorder: LlmLedgerRecorder,
  ) {}

  /**
   * Single-shot tool-use chat. Returns content + tool_calls + usage; the
   * agent loop reads tool_calls first.
   */
  async chatWithTools(
    args: {
      readonly messages: readonly ChatMessage[];
      readonly tools?: readonly ChatTool[];
    },
    ctx: LlmCallContext,
    opts: ResolveOptions = { scope: ctx.scope },
  ): Promise<ChatStepResult> {
    const resolved = this.resolve(opts);
    const client = this.getClient(resolved);
    const startedAt = Date.now();
    let result: ChatStepResult | null = null;
    try {
      result = await client.chatWithTools({
        messages: args.messages,
        ...(args.tools !== undefined ? { tools: args.tools } : {}),
        traceId: ctx.traceId,
      });
      return result;
    } catch (err) {
      this.recordFailure(resolved, ctx, startedAt, err);
      throw err;
    } finally {
      if (result !== null) {
        this.recordSuccess(resolved, ctx, startedAt, result.usage);
      }
    }
  }

  /**
   * Streaming finalize — yields incremental text chunks. The last chunk
   * has `done=true` and the cumulative usage. When `webSearch=true` and
   * the resolved provider supports it, the call is routed through the
   * provider-specific search backend.
   */
  async *chatStreamFinalize(
    args: { readonly messages: readonly ChatMessage[]; readonly webSearch?: boolean },
    ctx: LlmCallContext,
    opts: ResolveOptions = { scope: ctx.scope, needWebSearch: args.webSearch === true },
  ): AsyncIterable<ChatStreamChunk> {
    const resolved = this.resolve(opts);
    const client = this.getClient(resolved);
    const startedAt = Date.now();
    let lastUsage: ChatTokenUsage | undefined;
    let failed = false;
    try {
      for await (const chunk of client.chatStreamFinalize({
        messages: args.messages,
        traceId: ctx.traceId,
        ...(args.webSearch === true ? { webSearch: true } : {}),
      })) {
        if (chunk.usage) lastUsage = chunk.usage;
        yield chunk;
      }
    } catch (err) {
      failed = true;
      this.recordFailure(resolved, ctx, startedAt, err);
      throw err;
    } finally {
      if (!failed) {
        this.recordSuccess(resolved, ctx, startedAt, lastUsage ?? ZERO_USAGE);
      }
    }
  }

  /** JSON-mode single-shot. Returns raw text, token usage, and resolved provider identity. */
  async completeJson(
    args: { readonly system: string; readonly user: string },
    ctx: LlmCallContext,
    opts: ResolveOptions = { scope: ctx.scope },
  ): Promise<{
    readonly text: string;
    readonly usage: ChatTokenUsage;
    readonly provider: string;
    readonly model: string;
  }> {
    const resolved = this.resolve(opts);
    const client = this.getClient(resolved);
    const startedAt = Date.now();
    let usage: ChatTokenUsage | null = null;
    try {
      const out = await client.completeJson({
        system: args.system,
        user: args.user,
        traceId: ctx.traceId,
      });
      usage = out.usage;
      return {
        text: out.text,
        usage: out.usage,
        provider: resolved.row.provider,
        model: resolved.model,
      };
    } catch (err) {
      this.recordFailure(resolved, ctx, startedAt, err);
      throw err;
    } finally {
      if (usage !== null) {
        this.recordSuccess(resolved, ctx, startedAt, usage);
      }
    }
  }

  // -------------------------------------------------------------------------
  // resolution + cache
  // -------------------------------------------------------------------------

  private resolve(opts: ResolveOptions): ResolvedProvider {
    const override =
      opts.scope === 'agent' && hasOverride(this.cfg.agent) ? this.cfg.agent : this.cfg.default;
    const row = pickRow(override, opts);
    const apiKey = resolveKey(row, override);
    if (apiKey === undefined || apiKey === '') {
      throw new QuantError(
        'LLM_FAILED',
        `no API key set for provider ${row.provider} (env ${row.apiKeyEnv} or override empty)`,
        { provider: row.provider, scope: opts.scope, env_key: row.apiKeyEnv },
      );
    }
    return {
      row,
      model: override.model ?? row.modelPro,
      apiKey,
      baseUrl: override.baseUrl ?? row.baseUrl,
      webSearchKind: override.webSearchKind ?? row.webSearchKind,
    };
  }

  private getClient(r: ResolvedProvider): OpenAiCompatibleLlmClient {
    const key = `${r.row.provider}|${r.model}|${r.baseUrl}|${r.webSearchKind ?? '-'}`;
    let cached = this.clientCache.get(key);
    if (cached !== undefined) return cached;
    cached = new OpenAiCompatibleLlmClient({
      providerRow: r.row,
      model: r.model,
      apiKey: r.apiKey,
      baseUrl: r.baseUrl,
      requestTimeoutMs: this.cfg.requestTimeoutMs,
      webSearchKind: r.webSearchKind,
    });
    this.clientCache.set(key, cached);
    return cached;
  }

  private recordSuccess(
    r: ResolvedProvider,
    ctx: LlmCallContext,
    startedAt: number,
    usage: ChatTokenUsage,
  ): void {
    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `llm_call_ok provider=${r.row.provider} model=${r.model} scope=${ctx.scope} usage_in=${String(usage.input)} usage_out=${String(usage.output)} usage_total=${String(usage.total)} duration_ms=${String(durationMs)} trace_id=${ctx.traceId} user_id=${ctx.userId}`,
    );
    this.recorder.record({
      userId: ctx.userId,
      providerRow: r.row,
      model: r.model,
      scope: ctx.scope,
      usage,
      durationMs,
      ok: true,
      traceId: ctx.traceId,
    });
  }

  private recordFailure(
    r: ResolvedProvider,
    ctx: LlmCallContext,
    startedAt: number,
    err: unknown,
  ): void {
    const durationMs = Date.now() - startedAt;
    const errMsg = err instanceof Error ? err.message : String(err);
    this.logger.warn(
      `llm_call_fail provider=${r.row.provider} model=${r.model} scope=${ctx.scope} duration_ms=${String(durationMs)} trace_id=${ctx.traceId} user_id=${ctx.userId} err=${errMsg}`,
    );
    this.recorder.record({
      userId: ctx.userId,
      providerRow: r.row,
      model: r.model,
      scope: ctx.scope,
      usage: ZERO_USAGE,
      durationMs,
      ok: false,
      traceId: ctx.traceId,
    });
  }
}

// ---------------------------------------------------------------------------
// pure resolution helpers
// ---------------------------------------------------------------------------

function hasOverride(o: LlmProviderOverride): boolean {
  return o.provider !== undefined || o.apiKey !== undefined || o.baseUrl !== undefined;
}

function pickRow(override: LlmProviderOverride, opts: ResolveOptions): LlmProviderRow {
  if (override.provider !== undefined && override.provider.length > 0) {
    const named = findProviderRow(override.provider);
    if (named === undefined) {
      throw new QuantError('LLM_FAILED', `unknown provider in override: ${override.provider}`, {
        provider: override.provider,
      });
    }
    return named;
  }
  const candidates = LLM_PROVIDERS.filter((p) =>
    opts.needWebSearch === true ? p.webSearchKind !== undefined : true,
  );
  for (const cand of candidates) {
    const key = process.env[cand.apiKeyEnv];
    if (typeof key === 'string' && key.length > 0) return cand;
  }
  // Last resort — return first candidate; resolveKey() will throw a
  // helpful error pointing at the missing env var.
  if (candidates[0] === undefined) {
    throw new QuantError('LLM_FAILED', 'provider catalog is empty', { count: 0 });
  }
  return candidates[0];
}

function resolveKey(
  row: LlmProviderRow,
  override: LlmProviderOverride,
): string | undefined {
  if (override.apiKey !== undefined && override.apiKey.length > 0) return override.apiKey;
  return process.env[row.apiKeyEnv];
}
