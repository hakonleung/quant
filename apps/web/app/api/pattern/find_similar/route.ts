/**
 * BFF for the 105 pattern-match flow.
 *
 *   POST /api/pattern/find_similar
 *
 * Validates the request shape with the shared schema, forwards it to
 * NestJS, and re-validates the response.
 */

import {
  PatternFindSimilarRequestSchema,
  PatternFindSimilarResponseSchema,
  TRACE_HEADER,
} from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  let body: z.infer<typeof PatternFindSimilarRequestSchema>;
  try {
    const raw: unknown = await request.json();
    body = PatternFindSimilarRequestSchema.parse(raw);
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
      '/api/pattern/find_similar',
      (raw) => PatternFindSimilarResponseSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
