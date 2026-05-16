/**
 * Qwen web-search streaming. Single chat call with
 * `extra_body: { enable_search: true }`; the platform performs the
 * search server-side and folds results into the streamed reply.
 *
 * No tool loop, no max-search budget — Qwen does not expose a per-call
 * search count. Caller-passed `webSearch=true` simply enables the flag.
 *
 * The OpenAI Node SDK's typings don't include the `extra_body` escape
 * hatch (it's a Python-OpenAI convention DashScope re-uses), so we cast
 * the request body through `unknown`.
 */

import type OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';

import {
  type ChatMessage,
  type ChatStreamChunk,
  type ChatTokenUsage,
  QuantError,
} from '@quant/shared';

import type { ChatStreamFinalizeArgs } from '../ports/llm-client.port.js';

export async function* runQwenWebSearchStream(
  client: OpenAI,
  model: string,
  args: ChatStreamFinalizeArgs,
  provider: string,
): AsyncIterable<ChatStreamChunk> {
  const messages: ChatCompletionMessageParam[] = args.messages.map(toOpenAiMessage);
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    extra_body: { enable_search: true },
  };
  if (args.responseFormat === 'json_object') {
    body['response_format'] = { type: 'json_object' };
  }
  let stream: Stream<ChatCompletionChunk>;
  try {
    stream = (await client.chat.completions.create(
      body as unknown as Parameters<typeof client.chat.completions.create>[0],
    )) as unknown as Stream<ChatCompletionChunk>;
  } catch (err) {
    throw wrapProviderError(err, provider);
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toOpenAiMessage(msg: ChatMessage): ChatCompletionMessageParam {
  if (msg.role === 'system' || msg.role === 'user') {
    return { role: msg.role, content: msg.content };
  }
  if (msg.role === 'assistant') {
    const calls = msg.toolCalls ?? [];
    if (calls.length === 0) return { role: 'assistant', content: msg.content };
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
  return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
}

function mapUsage(raw: {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}): ChatTokenUsage {
  const input = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0;
  const output = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0;
  const total = typeof raw.total_tokens === 'number' ? raw.total_tokens : input + output;
  return { input, output, total };
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
