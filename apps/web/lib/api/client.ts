/**
 * Browser-side fetch helper. The web app **only** calls the same-origin
 * Next.js BFF (`/api/...`); the BFF then forwards to the NestJS gateway
 * (modules/07-frontend.md §防腐层 / user feedback 2026-05).
 *
 * Why no env var: the browser never directly hits NestJS — the Next
 * route handlers do that on the server side. That keeps CORS and
 * upstream URLs out of the client bundle entirely.
 */

import { newTraceId, TRACE_HEADER } from '@quant/shared';

interface ApiOptions {
  readonly signal?: AbortSignal;
  readonly traceId?: string;
}

export async function apiGet<T>(
  path: string,
  parse: (raw: unknown) => T,
  options: ApiOptions = {},
): Promise<T> {
  return request('GET', path, undefined, parse, options);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  parse: (raw: unknown) => T,
  options: ApiOptions = {},
): Promise<T> {
  return request('POST', path, body, parse, options);
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  parse: (raw: unknown) => T,
  options: ApiOptions,
): Promise<T> {
  if (!path.startsWith('/api/')) {
    throw new Error(`apiGet/apiPost paths must be relative to /api/: ${path}`);
  }
  const headers: Record<string, string> = {
    [TRACE_HEADER]: options.traceId ?? newTraceId(),
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (options.signal !== undefined) init.signal = options.signal;
  const res = await fetch(path, init);
  if (!res.ok) {
    throw new Error(`${path} → ${String(res.status)}`);
  }
  const raw: unknown = await res.json();
  return parse(raw);
}
