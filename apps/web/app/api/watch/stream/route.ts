/**
 * Streaming proxy for the NestJS Watch SSE endpoint.
 *
 * Mirrors `app/api/orchestration/queue/stream/route.ts`: forwards
 * `request.signal` so closing the EventSource releases the upstream
 * Nest connection, and pins headers so neither Next dev nor any
 * reverse proxy buffers the chunk stream. The body is the upstream
 * ReadableStream verbatim.
 */

import { TRACE_HEADER, newTraceId } from '@quant/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_NEST_BASE = 'http://127.0.0.1:3001';

export async function GET(request: Request): Promise<Response> {
  const trace = request.headers.get(TRACE_HEADER) ?? newTraceId();
  const base = process.env['QUANT_API_BASE'] ?? DEFAULT_NEST_BASE;

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/watch/stream`, {
      headers: {
        accept: 'text/event-stream',
        [TRACE_HEADER]: trace,
      },
      signal: request.signal,
      cache: 'no-store',
    });
  } catch (err) {
    return Response.json(
      {
        code: 'UPSTREAM_UNREACHABLE',
        message: err instanceof Error ? err.message : String(err),
        trace_id: trace,
      },
      { status: 502, headers: { [TRACE_HEADER]: trace } },
    );
  }

  if (!upstream.ok || upstream.body === null) {
    return Response.json(
      {
        code: 'UPSTREAM_ERROR',
        message: `upstream ${String(upstream.status)}`,
        trace_id: trace,
      },
      {
        status: upstream.status === 0 ? 502 : upstream.status,
        headers: { [TRACE_HEADER]: trace },
      },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      [TRACE_HEADER]: trace,
    },
  });
}
