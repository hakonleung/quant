/**
 * BFF: POST /api/watch → forward to NestJS `/api/watch`.
 *
 * Re-validates the request body and the upstream response against the
 * shared schemas so a contract drift fails on the BFF rather than
 * silently downstream. List reads go through the SSE stream
 * (`/api/watch/stream`), so no GET handler here.
 */

import { TRACE_HEADER, WatchTaskCreateSchema, WatchTaskSchema } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = WatchTaskCreateSchema.parse(raw);
    const created = await nestJson(request, '/api/watch', (r) => WatchTaskSchema.parse(r), {
      method: 'POST',
      body,
    });
    return Response.json(created, {
      status: 201,
      headers: { [TRACE_HEADER]: traceId },
    });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
