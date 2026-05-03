/**
 * Streaming proxy for the NestJS SSE endpoint.
 *
 * Why a custom handler instead of `nestProxy`:
 *   - SSE needs `request.signal` forwarded so the upstream Nest
 *     connection is released when the EventSource closes. Without
 *     this, every Next dev hot-reload leaked an open keepalive and the
 *     stream eventually stopped reconnecting (`SSE always cannot
 *     connect`).
 *   - The response headers are pinned explicitly (Content-Type,
 *     Cache-Control, X-Accel-Buffering=no) so neither the dev server
 *     nor any reverse proxy buffers the chunk stream.
 *   - The body is the upstream ReadableStream verbatim — no decoding
 *     and no re-encoding.
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
    upstream = await fetch(`${base}/api/orchestration/queue/stream`, {
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
