/**
 * Abstract surface every LLM adapter must expose. Three call shapes:
 *
 *   - `chatWithTools(...)` — one non-streaming round in tool-use mode.
 *     Used by the agent loop to decide between "call more tools" and
 *     "stream the final answer". Returns content (may be partial / null)
 *     and any tool calls the model emitted, plus token usage.
 *
 *   - `chatStreamFinalize(...)` — the "no more tools, just write the
 *     final answer" mode. Yields incremental text chunks and a final
 *     usage frame. Used at the end of the agent loop and by any other
 *     consumer that wants real-time output.
 *
 *   - `completeJson(...)` — single-shot chat completion forced into
 *     `response_format=json_object`. Replaces the Python
 *     `complete_json` API used by ledger analysis and NL→DSL.
 *
 * Web-search routing (Moonshot tool-loop / Qwen `extra_body.enable_search`)
 * is handled inside the adapter because it is provider-specific; callers
 * just pass `webSearch: true`.
 */

import type { ChatMessage, ChatStepResult, ChatStreamChunk, ChatTool } from '@quant/shared';

import type { LlmProviderRow } from '../providers.js';

export interface ChatWithToolsArgs {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatTool[];
  readonly traceId: string;
}

export interface ChatStreamFinalizeArgs {
  readonly messages: readonly ChatMessage[];
  readonly traceId: string;
  /** When true, route through the provider's web-search backend if it has one. */
  readonly webSearch?: boolean;
  /** When 'json_object', force the model to emit a single JSON object. */
  readonly responseFormat?: 'json_object';
}

export interface CompleteJsonArgs {
  readonly system: string;
  readonly user: string;
  readonly traceId: string;
}

/**
 * Adapters return their own provider/model identity so the recorder can
 * tag the ledger entry without an extra round-trip.
 */
export interface LlmClient {
  readonly providerRow: LlmProviderRow;
  readonly model: string;

  chatWithTools(args: ChatWithToolsArgs): Promise<ChatStepResult>;
  chatStreamFinalize(args: ChatStreamFinalizeArgs): AsyncIterable<ChatStreamChunk>;
  completeJson(
    args: CompleteJsonArgs,
  ): Promise<{ readonly text: string; readonly usage: ChatStepResult['usage'] }>;
}
