/**
 * BFF for the screen-signal backtest primitive.
 *
 *   POST /api/backtest/evaluate-signals  { signals, holdings }
 *
 * Validates the request shape, forwards to NestJS, re-parses the
 * response. The `evaluate-screen` variant lives in the sibling
 * `evaluate-screen/` folder; the streaming variant under
 * `evaluate-screen/stream/` because Next.js routes nest by folder.
 */

import {
  BacktestEvaluateResponseSchema,
  BacktestEvaluateSignalsRequestSchema,
  TRACE_HEADER,
} from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  let body: z.infer<typeof BacktestEvaluateSignalsRequestSchema>;
  try {
    const raw: unknown = await request.json();
    body = BacktestEvaluateSignalsRequestSchema.parse(raw);
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
      '/api/backtest/evaluate-signals',
      (raw) => BacktestEvaluateResponseSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
