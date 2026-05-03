/**
 * BFF for the kline bulk read.
 *
 *   GET /api/kline/bulk?codes=600519,000001&n=5
 *     → { "600519": KlineBar[], ... }
 *
 * One Flight call replaces N parallel single-code reads — without
 * which the list-panel saturated the browser socket pool with
 * ERR_INSUFFICIENT_RESOURCES.
 */

import { KlineBarSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const ResponseSchema = z.record(z.string(), z.array(KlineBarSchema));

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  const url = new URL(request.url);
  const codes = url.searchParams.get('codes') ?? '';
  const n = url.searchParams.get('n') ?? '5';
  if (codes.length === 0) {
    return Response.json({}, { headers: { [TRACE_HEADER]: traceId } });
  }
  try {
    const result = await nestJson(
      request,
      `/api/kline/bulk?codes=${encodeURIComponent(codes)}&n=${encodeURIComponent(n)}`,
      (raw) => ResponseSchema.parse(raw),
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
