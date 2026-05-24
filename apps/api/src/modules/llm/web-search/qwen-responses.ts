/**
 * Qwen Responses-API streaming (qwen3-max & later). Sibling of
 * `qwen-extra-body.ts` but talks to `client.responses.create()` instead
 * of `client.chat.completions.create()`. The Responses endpoint exposes
 * built-in tools server-side — we enable the standard trio
 * `web_search` + `web_extractor` + `code_interpreter` and rely on Qwen
 * to invoke them as needed. `extra_body.enable_thinking=true` turns on
 * the reasoning pass.
 *
 * Selected via `webSearchKind: 'qwen_responses'` in providers.ts so the
 * legacy `qwen_extra_body` path still works for callers pinned to the
 * older chat.completions+enable_search flow.
 */

import type OpenAI from 'openai';
import type {
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { Stream } from 'openai/streaming';

import {
  type ChatMessage,
  type ChatStreamChunk,
  type ChatTokenUsage,
  QuantError,
} from '@quant/shared';

import type { ChatStreamFinalizeArgs } from '../ports/llm-client.port.js';

export async function* runQwenResponsesStream(
  client: OpenAI,
  model: string,
  args: ChatStreamFinalizeArgs,
  provider: string,
): AsyncIterable<ChatStreamChunk> {
  const input: ResponseInputItem[] = args.messages.map(toResponsesItem);
  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    tools: [
      { type: 'web_search' },
      { type: 'web_extractor' },
      { type: 'code_interpreter' },
    ],
    extra_body: { enable_thinking: true },
  };
  if (args.responseFormat === 'json_object') {
    body['text'] = { format: { type: 'json_object' } };
  }
  let stream: Stream<ResponseStreamEvent>;
  try {
    stream = (await client.responses.create(
      body as unknown as Parameters<typeof client.responses.create>[0],
    )) as unknown as Stream<ResponseStreamEvent>;
  } catch (err) {
    throw wrapProviderError(err, provider);
  }
  let lastUsage: ChatTokenUsage | undefined;
  for await (const evt of stream) {
    if (evt.type === 'response.output_text.delta') {
      const delta = evt.delta;
      if (delta.length > 0) yield { delta, done: false };
      continue;
    }
    if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
      const usage = evt.response.usage;
      if (usage !== undefined && usage !== null) lastUsage = mapUsage(usage);
      continue;
    }
    if (evt.type === 'response.failed') {
      const msg = evt.response.error?.message ?? 'response failed';
      throw new QuantError('LLM_FAILED', `${provider}: ${msg}`, { source: provider });
    }
    if (evt.type === 'error') {
      throw new QuantError('LLM_FAILED', `${provider}: ${evt.message}`, { source: provider });
    }
  }
  yield { delta: '', done: true, ...(lastUsage !== undefined ? { usage: lastUsage } : {}) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toResponsesItem(msg: ChatMessage): ResponseInputItem {
  if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
    return { role: msg.role, content: msg.content } as ResponseInputItem;
  }
  return {
    type: 'function_call_output',
    call_id: msg.toolCallId,
    output: msg.content,
  } as ResponseInputItem;
}

function mapUsage(raw: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
}): ChatTokenUsage {
  const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0;
  const output = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0;
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
