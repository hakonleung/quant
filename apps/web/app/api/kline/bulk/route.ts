/**
 * BFF for the kline bulk read.
 *
 *   GET /api/kline/bulk?n=5                     → full universe
 *   GET /api/kline/bulk?codes=600519,000001&n=5 → subset
 *     → { "600519": KlineBar[], ... }
 *
 * Bulk is best-effort by design: missing data is preferable to a hard
 * failure, because the list-panel renders a "—" for codes without
 * stats but breaks for the whole sector if the request 4xx/5xx's. So
 * any upstream error (Python op missing, Flight unreachable, schema
 * drift) is swallowed here and surfaced as a 200 `{}`. The
 * `x-trace-id` header is preserved so server logs still correlate.
 */

import { KlineBarSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { nestJson, readTrace } from '../../_lib/proxy.js';

const ResponseSchema = z.record(z.string(), z.array(KlineBarSchema));

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  const url = new URL(request.url);
  const codes = url.searchParams.get('codes') ?? '';
  const n = url.searchParams.get('n') ?? '5';
  const upstreamPath =
    codes.length === 0
      ? `/api/kline/bulk?n=${encodeURIComponent(n)}`
      : `/api/kline/bulk?codes=${encodeURIComponent(codes)}&n=${encodeURIComponent(n)}`;
  try {
    const result = await nestJson(
      request,
      upstreamPath,
      (raw) => ResponseSchema.parse(raw),
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    // Always degrade to {} — the UI prefers partial / empty rendering
    // over a hard error response. `bffErrorResponse` was the previous
    // behaviour and propagated upstream 4xx/5xx, which broke the
    // entire list panel whenever one Flight op was unavailable.
    return Response.json(
      {},
      {
        status: 200,
        headers: {
          [TRACE_HEADER]: traceId,
          'x-bulk-fallback': err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        },
      },
    );
  }
}
