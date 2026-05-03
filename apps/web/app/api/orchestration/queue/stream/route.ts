/**
 * Streaming proxy for the NestJS SSE endpoint. Next.js route handlers
 * can return a `Response` whose body is the upstream stream verbatim,
 * so the BFF stays a thin pass-through (no buffering).
 */

import { nestProxy } from '../../../_lib/proxy.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return nestProxy(request, '/api/orchestration/queue/stream');
}
