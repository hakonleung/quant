/**
 * BFF for the kline bulk read.
 *
 *   GET /api/kline/bulk?n=5                     → full universe
 *   GET /api/kline/bulk?codes=600519,000001&n=5 → subset
 *     → { "600519": KlineBar[], ... }
 *
 * One Flight call replaces N parallel single-code reads. Codes whose
 * parquet is missing are simply absent from the response — never a
 * 404 even if every requested code is missing.
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
    return bffErrorResponse(err, traceId);
  }
}
