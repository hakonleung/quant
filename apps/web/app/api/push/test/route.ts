/**
 * BFF: POST /api/push/test → forward to NestJS `/api/push/test`.
 */

import { PushTestRequestSchema, PushTestResponseSchema, TRACE_HEADER } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = PushTestRequestSchema.parse(raw);
    const result = await nestJson(
      request,
      '/api/push/test',
      (r) => PushTestResponseSchema.parse(r),
      { method: 'POST', body },
    );
    return Response.json(result, {
      status: 200,
      headers: { [TRACE_HEADER]: traceId },
    });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
