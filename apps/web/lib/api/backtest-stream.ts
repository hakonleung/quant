/**
 * Client for `POST /api/backtest/evaluate-screen/stream`.
 *
 * The endpoint returns `text/event-stream` (one `data: <json>\n\n` line
 * per event). Events:
 *   - `{ type: 'progress', phase, day, runDays, totalDays, matchedDays, signals }`
 *   - `{ type: 'result', payload: BacktestEvaluateResponse }`
 *   - `{ type: 'error', message }`
 *
 * Why fetch + ReadableStream (not EventSource): EventSource is GET-only,
 * and our request body (a full screen AST) is too large for a query
 * string. We parse the line protocol manually — it's a few dozen lines
 * and avoids pulling in an SSE polyfill.
 */

import {
  BacktestEvaluateResponseSchema,
  type BacktestEvaluateResponse,
  type BacktestEvaluateScreenRequest,
} from '@quant/shared';
import { z } from 'zod';

const ProgressEventSchema = z.object({
  type: z.literal('progress'),
  phase: z.enum(['screen', 'flight']),
  day: z.string().nullable(),
  runDays: z.number().int().nonnegative(),
  totalDays: z.number().int().nonnegative(),
  matchedDays: z.number().int().nonnegative(),
  signals: z.number().int().nonnegative(),
});
const ResultEventSchema = z.object({
  type: z.literal('result'),
  payload: z.unknown(),
});
const ErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});
const StreamEventSchema = z.union([ProgressEventSchema, ResultEventSchema, ErrorEventSchema]);

export interface ScreenProgressEvent {
  readonly phase: 'screen' | 'flight';
  readonly day: string | null;
  readonly runDays: number;
  readonly totalDays: number;
  readonly matchedDays: number;
  readonly signals: number;
}

export interface BacktestStreamCallbacks {
  readonly onProgress?: (event: ScreenProgressEvent) => void;
  readonly signal?: AbortSignal;
}

export async function streamEvaluateBacktestScreen(
  req: BacktestEvaluateScreenRequest,
  cb: BacktestStreamCallbacks = {},
): Promise<BacktestEvaluateResponse> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  };
  if (cb.signal !== undefined) init.signal = cb.signal;
  const res = await fetch('/api/backtest/evaluate-screen/stream', init);
  if (!res.ok) {
    throw new Error(`/api/backtest/evaluate-screen/stream → ${String(res.status)}`);
  }
  if (res.body === null) {
    throw new Error('streaming response has no body');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: BacktestEvaluateResponse | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) buffer += decoder.decode(value, { stream: !done });
    final = consumeEvents(buffer, cb.onProgress, (parsed) => {
      buffer = parsed.rest;
      if (parsed.error !== null) throw new Error(parsed.error);
      return parsed.result;
    }) ?? final;
    if (done) break;
  }
  if (final === null) {
    throw new Error('stream ended without a result event');
  }
  return final;
}

interface ConsumeResult {
  readonly rest: string;
  readonly result: BacktestEvaluateResponse | null;
  readonly error: string | null;
}

/**
 * Parse all complete `data: …\n\n` blocks in `buffer`, dispatch progress
 * events through `onProgress`, and return the final `result` payload if
 * one was seen. `finalise` is the seam that lets the caller update its
 * buffer + throw on error from the same control flow.
 */
function consumeEvents(
  buffer: string,
  onProgress: BacktestStreamCallbacks['onProgress'],
  finalise: (parsed: ConsumeResult) => BacktestEvaluateResponse | null,
): BacktestEvaluateResponse | null {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  let result: BacktestEvaluateResponse | null = null;
  let error: string | null = null;
  for (const block of parts) {
    const evt = parseEvent(block);
    if (evt === null) continue;
    if (evt.type === 'progress' && onProgress !== undefined) {
      onProgress(evt);
    } else if (evt.type === 'result') {
      result = BacktestEvaluateResponseSchema.parse(evt.payload);
    } else if (evt.type === 'error') {
      error = evt.message;
    }
  }
  return finalise({ rest, result, error });
}

type StreamEvent = z.infer<typeof StreamEventSchema>;

function parseEvent(block: string): StreamEvent | null {
  const line = block.trim();
  if (!line.startsWith('data:')) return null;
  const json = line.slice(line.indexOf(':') + 1).trim();
  if (json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const safe = StreamEventSchema.safeParse(parsed);
  return safe.success ? safe.data : null;
}
