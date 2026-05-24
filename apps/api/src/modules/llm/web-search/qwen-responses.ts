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

import { Logger } from '@nestjs/common';
import type OpenAI from 'openai';
import type { ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { Stream } from 'openai/streaming';

import {
  type ChatMessage,
  type ChatStreamChunk,
  type ChatTokenUsage,
  QuantError,
} from '@quant/shared';

import type { ChatStreamFinalizeArgs } from '../ports/llm-client.port.js';

const log = new Logger('qwenResponsesStream');

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
    tools: [{ type: 'web_search' }, { type: 'web_extractor' }, { type: 'code_interpreter' }],
    // extra_body: { enable_thinking: true },
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
  let deltaTextLen = 0;
  const eventTypes = new Set<string>();
  let fallbackText = '';
  for await (const evt of stream) {
    eventTypes.add(evt.type);
    if (evt.type === 'response.output_text.delta') {
      const delta = evt.delta;
      if (delta.length > 0) {
        deltaTextLen += delta.length;
        yield { delta, done: false };
      }
      continue;
    }
    if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
      const usage = evt.response.usage;
      if (usage !== undefined && usage !== null) lastUsage = mapUsage(usage);
      // Fallback path: if Qwen never streamed output_text.delta (e.g. when
      // a built-in tool short-circuits the response) the final `response`
      // object still contains the assistant message text. Extract once.
      if (deltaTextLen === 0) {
        fallbackText = extractFinalText(evt.response);
      }
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
  if (deltaTextLen === 0 && fallbackText.length > 0) {
    yield { delta: fallbackText, done: false };
    deltaTextLen = fallbackText.length;
  }
  if (deltaTextLen === 0) {
    log.warn(`qwen_responses_empty provider=${provider} events=${[...eventTypes].join(',')}`);
  }
  yield { delta: '', done: true, ...(lastUsage !== undefined ? { usage: lastUsage } : {}) };
}

/**
 * Pull plain text out of a finalized response object. Walks
 * `response.output[*].content[*]` looking for any text-bearing part.
 * Defensive: the OpenAI Responses SDK types describe several shapes
 * (`output_text`, `text`, `message`), and Qwen's port may add its own.
 */
function extractFinalText(response: unknown): string {
  if (response === null || typeof response !== 'object') return '';
  const out = (response as { output?: unknown }).output;
  if (!Array.isArray(out)) return '';
  const parts: string[] = [];
  for (const item of out) {
    if (item === null || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c === null || typeof c !== 'object') continue;
      const t = (c as { text?: unknown }).text;
      if (typeof t === 'string' && t.length > 0) parts.push(t);
    }
  }
  return parts.join('');
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
