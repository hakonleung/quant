/**
 * BFF for the cache-only backtest read (mirrors the analyze cached-GET
 * pattern but with POST + body, since the request carries a full screen
 * AST that won't fit in a URL).
 *
 *   POST /api/backtest/evaluate-screen/cached
 *     200 + BacktestEvaluateResponse on hit
 *     404 on miss (FE renders the empty state with a "RUN" CTA)
 *
 * The upstream 404 is forwarded verbatim by `bffErrorResponse`, so
 * `fetch(...).status === 404` is the FE's miss signal — no need to
 * inspect the body.
 */

import {
  BacktestEvaluateResponseSchema,
  BacktestEvaluateScreenRequestSchema,
  TRACE_HEADER,
} from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../../_lib/proxy.js';

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
      '/api/backtest/evaluate-screen/cached',
      (raw) => BacktestEvaluateResponseSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
