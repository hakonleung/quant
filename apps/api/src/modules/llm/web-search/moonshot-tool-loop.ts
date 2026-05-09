/**
 * Moonshot (Kimi) `$web_search` builtin_function tool loop, streaming variant.
 *
 * Per Moonshot's spec we drive a tool loop where:
 *   1. Each turn we call chat.completions with `tools=[{type:'builtin_function',
 *      function:{name:'$web_search'}}]`.
 *   2. If the assistant emits `tool_calls`, we echo them back as
 *      `role:'tool'` messages whose content is the verbatim arguments
 *      string (Moonshot performs the search server-side and folds the
 *      result into the next assistant turn).
 *   3. When the assistant returns `finish_reason='stop'` (no tool_calls),
 *      we yield that final reply text back to the caller in 64-char
 *      chunks so the streaming contract is preserved.
 *
 * Differences from the Python version:
 *   - Intermediate non-final turns are non-streamed (faithful to Python).
 *     Only the last turn's content is chunked back to the caller.
 *   - `MAX_SEARCHES` is hardcoded to 4 — a hard ceiling, not caller-tunable.
 *   - Kimi k2.6+ requires `extra_body.thinking.type='disabled'`; the OpenAI
 *     SDK's TS types don't model `extra_body`, so we cast the request body.
 *   - `temperature: 0.6` is the only value Kimi accepts on this surface.
 */

import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  type ChatMessage,
  type ChatStreamChunk,
  type ChatTokenUsage,
  QuantError,
} from '@quant/shared';

import type { ChatStreamFinalizeArgs } from '../ports/llm-client.port.js';

const MAX_SEARCHES = 4;
const MAX_TURNS = MAX_SEARCHES * 2 + 4;
const TURN_TIMEOUT_MS = 240_000;
const STREAM_CHUNK_CHARS = 64;

export async function* runMoonshotWebSearchStream(
  client: OpenAI,
  model: string,
  args: ChatStreamFinalizeArgs,
  provider: string,
): AsyncIterable<ChatStreamChunk> {
  const messages: ChatCompletionMessageParam[] = args.messages.map(toOpenAiMessage);
  let allowTools = true;
  let searchesUsed = 0;
  const usageAcc: ChatTokenUsage = { input: 0, output: 0, total: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body: Record<string, unknown> = {
      model,
      temperature: 0.6,
      messages,
      extra_body: { thinking: { type: 'disabled' } },
    };
    if (allowTools) {
      body['tools'] = [{ type: 'builtin_function', function: { name: '$web_search' } }];
    }
    let response: ChatCompletion;
    try {
      response = await client.chat.completions.create(
        // The OpenAI TS types don't model `extra_body` / `builtin_function`
        // tools — Moonshot accepts both. Cast through unknown to bypass.
        body as unknown as Parameters<typeof client.chat.completions.create>[0],
        { timeout: TURN_TIMEOUT_MS },
      ) as unknown as ChatCompletion;
    } catch (err) {
      throw wrapProviderError(err, provider);
    }
    const choice = response.choices[0];
    if (choice === undefined) {
      throw new QuantError('LLM_FAILED', `${provider}: response has no choices`, {
        source: provider,
      });
    }
    accumulateUsage(usageAcc, response.usage);
    const message = choice.message;
    const toolCalls: readonly ChatCompletionMessageToolCall[] = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const final = typeof message.content === 'string' ? message.content : '';
      for (let i = 0; i < final.length; i += STREAM_CHUNK_CHARS) {
        yield { delta: final.slice(i, i + STREAM_CHUNK_CHARS), done: false };
      }
      yield { delta: '', done: true, usage: usageAcc };
      return;
    }

    rejectUnknownTools(toolCalls, provider);

    messages.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: nameOf(tc), arguments: argsOf(tc) },
      })),
    });
    for (const tc of toolCalls) {
      searchesUsed += 1;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: argsOf(tc),
      });
    }
    if (searchesUsed >= MAX_SEARCHES) {
      messages.push({
        role: 'user',
        content:
          'You have reached the web_search budget. Do not call any more tools. ' +
          'Produce the final answer now using only what you have retrieved so far.',
      });
      allowTools = false;
    }
  }
  throw new QuantError(
    'LLM_FAILED',
    `${provider}: web_search loop exceeded ${MAX_TURNS} turns`,
    { source: provider, max_turns: MAX_TURNS },
  );
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

function nameOf(tc: ChatCompletionMessageToolCall): string {
  const fn = (tc as unknown as { function?: { name?: unknown } }).function;
  const name = fn?.name;
  return typeof name === 'string' ? name : '';
}

function argsOf(tc: ChatCompletionMessageToolCall): string {
  const fn = (tc as unknown as { function?: { arguments?: unknown } }).function;
  const args = fn?.arguments;
  return typeof args === 'string' ? args : '';
}

function rejectUnknownTools(
  toolCalls: readonly ChatCompletionMessageToolCall[],
  provider: string,
): void {
  const unknown = toolCalls.map((tc) => nameOf(tc)).filter((n) => n !== '$web_search' && n !== '');
  if (unknown.length > 0) {
    throw new QuantError(
      'LLM_FAILED',
      `${provider}: model invoked unsupported tool`,
      { source: provider, tools: unknown },
    );
  }
}

function accumulateUsage(
  acc: { input: number; output: number; total: number },
  raw:
    | { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null }
    | null
    | undefined,
): void {
  if (raw === null || raw === undefined) return;
  acc.input += typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0;
  acc.output += typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0;
  acc.total = acc.input + acc.output;
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
