/**
 * OpenAI-compatible chat-completion adapter.
 *
 * Speaks the OpenAI chat-completion wire format that DeepSeek / Moonshot /
 * Qwen / Doubao / OpenAI itself all expose. Three call shapes:
 *
 *   - `chatWithTools` — non-streaming tool-use round; returns content +
 *     tool_calls + usage. The agent loop reads tool_calls first; if empty,
 *     it switches to streaming finalize.
 *   - `chatStreamFinalize` — streaming text-only; yields delta chunks and
 *     a final usage frame from the OpenAI `[DONE]` event. When `webSearch`
 *     is set and the provider has `webSearchKind` configured, routes
 *     through Moonshot's `$web_search` builtin_function tool loop or
 *     Qwen's `extra_body.enable_search` single shot.
 *   - `completeJson` — single shot in `response_format: json_object`.
 *
 * No retries here — callers (services) own retry policy because timing
 * and idempotency vary by use case.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

import {
  type ChatMessage,
  type ChatStepResult,
  type ChatStreamChunk,
  type ChatTokenUsage,
  type ChatTool,
  type ChatToolCall,
  QuantError,
} from '@quant/shared';

import type {
  ChatStreamFinalizeArgs,
  ChatWithToolsArgs,
  CompleteJsonArgs,
  LlmClient,
} from '../ports/llm-client.port.js';
import { runMoonshotWebSearchStream } from '../web-search/moonshot-tool-loop.js';
import { runQwenWebSearchStream } from '../web-search/qwen-extra-body.js';
import type { LlmProviderRow, WebSearchKind } from '../providers.js';

export interface OpenAiCompatibleClientOptions {
  readonly providerRow: LlmProviderRow;
  /** Override the catalog row's model — used by AGENT_LLM_MODEL etc. */
  readonly model: string;
  readonly apiKey: string;
  /** Override the catalog row's base URL — used when caller pins via env. */
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  /** Override the catalog row's webSearchKind — used by AGENT_LLM_WEB_SEARCH_KIND. */
  readonly webSearchKind?: WebSearchKind | undefined;
  /** Test seam: inject a stub OpenAI client. */
  readonly client?: OpenAI;
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly providerRow: LlmProviderRow;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly webSearchKind: WebSearchKind | undefined;

  constructor(opts: OpenAiCompatibleClientOptions) {
    this.providerRow = opts.providerRow;
    this.model = opts.model;
    this.webSearchKind = opts.webSearchKind ?? opts.providerRow.webSearchKind;
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseUrl.replace(/\/+$/u, ''),
        timeout: opts.requestTimeoutMs,
      });
  }

  async chatWithTools(args: ChatWithToolsArgs): Promise<ChatStepResult> {
    const messages = args.messages.map(toOpenAiMessage);
    const tools = (args.tools ?? []).map(toOpenAiTool);
    let response;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      });
    } catch (err) {
      throw wrapProviderError(err, this.providerRow.provider);
    }
    const choice = response.choices[0];
    if (choice === undefined) {
      throw new QuantError('LLM_FAILED', `${this.providerRow.provider}: response has no choices`, {
        source: this.providerRow.provider,
      });
    }
    const message = choice.message;
    const toolCalls = (message.tool_calls ?? []).map(parseToolCall);
    const usage = mapUsage(response.usage);
    const finishReason = mapFinishReason(choice.finish_reason);
    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls,
      usage,
      finishReason,
    };
  }

  async *chatStreamFinalize(args: ChatStreamFinalizeArgs): AsyncIterable<ChatStreamChunk> {
    if (args.webSearch === true && this.webSearchKind === 'qwen_extra_body') {
      yield* runQwenWebSearchStream(this.client, this.model, args, this.providerRow.provider);
      return;
    }
    if (args.webSearch === true && this.webSearchKind === 'moonshot_tool') {
      yield* runMoonshotWebSearchStream(this.client, this.model, args, this.providerRow.provider);
      return;
    }
    yield* this.streamPlainChat(args);
  }

  private async *streamPlainChat(args: ChatStreamFinalizeArgs): AsyncIterable<ChatStreamChunk> {
    const messages = args.messages.map(toOpenAiMessage);
    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      });
    } catch (err) {
      throw wrapProviderError(err, this.providerRow.provider);
    }
    let lastUsage: ChatTokenUsage | undefined;
    for await (const evt of stream) {
      const choice = evt.choices[0];
      const delta = choice?.delta?.content ?? '';
      if (evt.usage) {
        lastUsage = mapUsage(evt.usage);
      }
      if (delta.length > 0) {
        yield { delta, done: false };
      }
    }
    yield { delta: '', done: true, ...(lastUsage !== undefined ? { usage: lastUsage } : {}) };
  }

  async completeJson(
    args: CompleteJsonArgs,
  ): Promise<{ readonly text: string; readonly usage: ChatTokenUsage }> {
    let response;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
      });
    } catch (err) {
      throw wrapProviderError(err, this.providerRow.provider);
    }
    const choice = response.choices[0];
    if (choice === undefined) {
      throw new QuantError('LLM_FAILED', `${this.providerRow.provider}: response has no choices`, {
        source: this.providerRow.provider,
      });
    }
    const text = choice.message.content;
    if (typeof text !== 'string') {
      throw new QuantError(
        'LLM_FAILED',
        `${this.providerRow.provider}: response 'content' is not a string`,
        { source: this.providerRow.provider },
      );
    }
    return { text, usage: mapUsage(response.usage) };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toOpenAiMessage(msg: ChatMessage): ChatCompletionMessageParam {
  if (msg.role === 'system' || msg.role === 'user') {
    return { role: msg.role, content: msg.content };
  }
  if (msg.role === 'assistant') {
    const calls = msg.toolCalls ?? [];
    if (calls.length === 0) {
      return { role: 'assistant', content: msg.content };
    }
    return {
      role: 'assistant',
      content: msg.content,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.toolId, arguments: JSON.stringify(c.args) },
      })),
    };
  }
  return {
    role: 'tool',
    tool_call_id: msg.toolCallId,
    content: msg.content,
  };
}

function toOpenAiTool(tool: ChatTool): {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
} {
  return {
    type: 'function',
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.schema,
    },
  };
}

interface RawToolCall {
  readonly id?: string | null;
  readonly function?: { readonly name?: string | null; readonly arguments?: string | null } | null;
}

function parseToolCall(raw: RawToolCall): ChatToolCall {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const fn = raw.function ?? null;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  const argsRaw = typeof fn?.arguments === 'string' ? fn.arguments : '{}';
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    args = isRecord(parsed) ? parsed : {};
  } catch {
    args = {};
  }
  if (id === '' || name === '') {
    throw new QuantError('LLM_FAILED', 'tool_call missing id or function.name', {
      raw_id: id,
      raw_name: name,
    });
  }
  return { id, toolId: name, args };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface RawUsage {
  readonly prompt_tokens?: number | null;
  readonly completion_tokens?: number | null;
  readonly total_tokens?: number | null;
}

function mapUsage(raw: RawUsage | null | undefined): ChatTokenUsage {
  const input = typeof raw?.prompt_tokens === 'number' ? raw.prompt_tokens : 0;
  const output = typeof raw?.completion_tokens === 'number' ? raw.completion_tokens : 0;
  const total = typeof raw?.total_tokens === 'number' ? raw.total_tokens : input + output;
  return { input, output, total };
}

function mapFinishReason(raw: string | null | undefined): ChatStepResult['finishReason'] {
  if (raw === 'tool_calls') return 'tool_calls';
  if (raw === 'length') return 'length';
  if (raw === 'content_filter') return 'content_filter';
  return 'stop';
}

function wrapProviderError(err: unknown, provider: string): QuantError {
  if (err instanceof QuantError) return err;
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return new QuantError('LLM_FAILED', `${provider}: ${name}: ${message}`, {
    source: provider,
    exc_type: name,
  });
}
