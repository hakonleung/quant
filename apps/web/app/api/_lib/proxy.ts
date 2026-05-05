/**
 * Server-side helper for the Next.js BFF (anti-corruption layer).
 *
 * The frontend talks only to same-origin Next routes; those routes
 * forward to the NestJS gateway running at `QUANT_API_BASE`
 * (default `http://127.0.0.1:3001`). The hop is intentional:
 *
 *   - browser only sees `/api/...` (no CORS, no env var leaks)
 *   - the BFF can reshape / mask Nest's response without touching the
 *     gateway code (CLAUDE.md §2.5 — UI plumbing belongs in `lib/`)
 *
 * Trace IDs are forwarded both ways so log lines stay correlated.
 */

import { TRACE_HEADER, newTraceId } from '@quant/shared';

const DEFAULT_NEST_BASE = 'http://127.0.0.1:3001';

function nestBase(): string {
  return process.env['QUANT_API_BASE'] ?? DEFAULT_NEST_BASE;
}

interface ProxyInit {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly body?: unknown;
}

/**
 * Proxy a request to NestJS and return its raw `Response`. Use this
 * for routes where the frontend wants the gateway shape verbatim
 * (or for SSE / streaming, where re-encoding would defeat the point).
 */
export async function nestProxy(
  request: Request,
  upstreamPath: string,
  init: ProxyInit = {},
): Promise<Response> {
  const headers = new Headers();
  const trace = request.headers.get(TRACE_HEADER) ?? newTraceId();
  headers.set(TRACE_HEADER, trace);
  if (init.body !== undefined) headers.set('content-type', 'application/json');

  const fetchInit: RequestInit = {
    method: init.method ?? 'GET',
    headers,
  };
  if (init.body !== undefined) fetchInit.body = JSON.stringify(init.body);
  const upstream = await fetch(`${nestBase()}${upstreamPath}`, fetchInit);

  const out = new Headers(upstream.headers);
  out.delete('content-encoding');
  out.delete('content-length');
  out.set(TRACE_HEADER, trace);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** Proxy and decode JSON; throw on non-2xx so the route can surface a 502. */
export async function nestJson<T>(
  request: Request,
  upstreamPath: string,
  parse: (raw: unknown) => T,
  init: ProxyInit = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const trace = request.headers.get(TRACE_HEADER) ?? newTraceId();
  headers[TRACE_HEADER] = trace;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const fetchInit: RequestInit = {
    method: init.method ?? 'GET',
    headers,
  };
  if (init.body !== undefined) fetchInit.body = JSON.stringify(init.body);
  const upstream = await fetch(`${nestBase()}${upstreamPath}`, fetchInit);

  if (!upstream.ok) {
    const body = await upstream.text();
    throw new BffUpstreamError(upstream.status, body);
  }
  const raw: unknown = await upstream.json();
  return parse(raw);
}

export class BffUpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`upstream ${String(status)}: ${body.slice(0, 200)}`);
    this.name = 'BffUpstreamError';
  }
}

export function bffErrorResponse(err: unknown, traceId: string): Response {
  if (err instanceof BffUpstreamError) {
    return Response.json(
      {
        code: 'UPSTREAM_ERROR',
        message: err.message,
        trace_id: traceId,
        details: { status: err.status },
      },
      { status: err.status >= 500 ? 502 : err.status, headers: { [TRACE_HEADER]: traceId } },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json(
    { code: 'INTERNAL', message, trace_id: traceId, details: {} },
    { status: 500, headers: { [TRACE_HEADER]: traceId } },
  );
}

export function readTrace(req: Request): string {
  return req.headers.get(TRACE_HEADER) ?? newTraceId();
}
