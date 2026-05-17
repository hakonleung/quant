/**
 * BFF for the screen-signal backtest orchestration (synchronous).
 *
 *   POST /api/backtest/evaluate-screen
 *
 * Long-running on big windows — the streaming sibling at
 * `evaluate-screen/stream` is the one the FE wires by default; this
 * non-streaming entry is kept for scripted callers (curl, tests).
 */

import {
  BacktestEvaluateResponseSchema,
  BacktestEvaluateScreenRequestSchema,
  TRACE_HEADER,
} from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  let body: z.infer<typeof BacktestEvaluateScreenRequestSchema>;
  try {
    const raw: unknown = await request.json();
    body = BacktestEvaluateScreenRequestSchema.parse(raw);
  } catch (err) {
    return Response.json(
      {
        code: 'INVALID_ARGUMENT',
        message: err instanceof Error ? err.message : String(err),
        trace_id: traceId,
        details: {},
      },
      { status: 400, headers: { [TRACE_HEADER]: traceId } },
    );
  }

  try {
    const result = await nestJson(
      request,
      '/api/backtest/evaluate-screen',
      (raw) => BacktestEvaluateResponseSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
