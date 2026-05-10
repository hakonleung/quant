/**
 * BFF for ta analyze_many — sector fan-out.
 *
 * Always paid (POST) for v1. Caching, if any, lives on each per-stock
 * analyze_ta_one call (Python side).
 */

import { TaSectorAnalysisSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const BodySchema = z
  .object({
    codes: z
      .array(z.string().regex(/^\d{6}$/u))
      .min(1)
      .max(50),
    label: z.string().min(1).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  let body: z.infer<typeof BodySchema>;
  try {
    const raw: unknown = await request.json();
    body = BodySchema.parse(raw);
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
      '/api/ta/analyze_many',
      (raw) => TaSectorAnalysisSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
