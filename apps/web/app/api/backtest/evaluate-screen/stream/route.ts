/**
 * BFF passthrough for the streaming backtest endpoint.
 *
 *   POST /api/backtest/evaluate-screen/stream  →  text/event-stream
 *
 * Validation happens NestJS-side (the request body is the same shape
 * as the sync variant — duplicating zod here would just delay the
 * first byte). We re-emit the upstream body stream verbatim so the
 * browser's fetch + ReadableStream sees the same `data: …\n\n` blocks
 * the NestJS controller writes.
 *
 * `nestProxy` already pipes `upstream.body` through unchanged, so
 * there's nothing custom to do here beyond setting the route handler
 * to dynamic + telling Next not to buffer.
 */

import { TRACE_HEADER, newTraceId } from '@quant/shared';

import { bffErrorResponse, nestProxy } from '../../../_lib/proxy.js';

// Streams must not be statically optimised / cached at the Next layer.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const traceId = request.headers.get(TRACE_HEADER) ?? newTraceId();
  try {
    const raw = await request.text();
    const parsedBody: unknown = raw.length === 0 ? undefined : JSON.parse(raw);
    const init: { method: 'POST'; body?: unknown } = { method: 'POST' };
    if (parsedBody !== undefined) init.body = parsedBody;
    const upstream = await nestProxy(request, '/api/backtest/evaluate-screen/stream', init);
    // Force content-type so the browser surfaces the stream correctly
    // even if some intermediate stripped it.
    const headers = new Headers(upstream.headers);
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('x-accel-buffering', 'no');
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
