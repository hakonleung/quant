/**
 * BFF: DELETE /api/watch/groups/:name → NestJS cascade-delete.
 *
 * Cascades on the server: deletes every task referencing the group,
 * then drops the group config. Mirrors the upstream 204 status.
 */

import { TRACE_HEADER, newTraceId } from '@quant/shared';

const DEFAULT_NEST_BASE = 'http://127.0.0.1:3001';

interface RouteCtx {
  readonly params: Promise<{ readonly name: string }>;
}

export async function DELETE(request: Request, ctx: RouteCtx): Promise<Response> {
  const trace = request.headers.get(TRACE_HEADER) ?? newTraceId();
  const base = process.env['QUANT_API_BASE'] ?? DEFAULT_NEST_BASE;
  const { name } = await ctx.params;
  const url = `${base}/api/watch/groups/${encodeURIComponent(name)}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'DELETE',
      headers: { [TRACE_HEADER]: trace },
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

  if (upstream.status === 204) {
    return new Response(null, { status: 204, headers: { [TRACE_HEADER]: trace } });
  }
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      [TRACE_HEADER]: trace,
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    },
  });
}
